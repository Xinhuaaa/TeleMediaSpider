import { createWriteStream, promises as fs } from 'fs';
import { Api, TelegramClient } from 'telegram';
import { Logger } from 'telegram/extensions/Logger';
import { FileMigrateError } from 'telegram/errors';
import { MTProtoSender } from 'telegram/network';
import bigInt from 'big-integer';

/**
 * Configuration for accelerated download
 */
export interface DownloadConfig {
    enableDownloadAcceleration: boolean;
    downloadThreads: number;
    chunkSize: number;
    maxRetries: number;
}

/**
 * Progress callback function type - matches Telegram API signature
 */
export type ProgressCallback = (downloaded: bigInt.BigInteger, total: bigInt.BigInteger) => void;

/**
 * Chunk download task
 */
interface ChunkTask {
    offset: number;
    limit: number;
    retries: number;
}

/**
 * Accelerated Downloader for Telegram media files
 * Uses multiple concurrent connections to download file chunks in parallel
 */
export class AcceleratedDownloader {
    private client: TelegramClient;
    private config: DownloadConfig;
    private logger?: Logger;

    constructor(client: TelegramClient, config: DownloadConfig, logger?: Logger) {
        this.client = client;
        this.config = config;
        this.logger = logger;
    }

    /**
     * Download media with acceleration
     * @param media The media to download
     * @param progressCallback Progress callback
     * @returns Buffer containing the downloaded file
     */
    async downloadMedia(
        media: Api.TypeMessageMedia,
        progressCallback?: ProgressCallback
    ): Promise<Buffer> {
        // If acceleration is disabled, fall back to standard download
        if (!this.config.enableDownloadAcceleration) {
            const result = await this.client.downloadMedia(media, {
                progressCallback: progressCallback,
            });
            return Buffer.isBuffer(result) ? result : Buffer.from(result as string);
        }

        // Get file information
        const fileInfo = this.getFileInfo(media);
        if (!fileInfo) {
            // If we can't get file info, fall back to standard download
            const result = await this.client.downloadMedia(media, {
                progressCallback: progressCallback,
            });
            return Buffer.isBuffer(result) ? result : Buffer.from(result as string);
        }

        const { location, size, dcId } = fileInfo;

        // For small files (< 1MB), use standard download as it's more efficient
        if (size < 1024 * 1024) {
            const result = await this.client.downloadMedia(media, {
                progressCallback: progressCallback,
            });
            return Buffer.isBuffer(result) ? result : Buffer.from(result as string);
        }

        // Use accelerated download for larger files
        return await this.downloadFileAccelerated(
            location,
            size,
            dcId,
            progressCallback
        );
    }

    /**
     * Extract file information from media
     */
    private getFileInfo(media: Api.TypeMessageMedia): {
        location: Api.TypeInputFileLocation;
        size: number;
        dcId?: number;
    } | null {
        if (media instanceof Api.MessageMediaPhoto) {
            const photo = media.photo as Api.Photo;
            if (!photo || !(photo instanceof Api.Photo)) {
                return null;
            }

            // Get the largest photo size
            let largestSize: Api.TypePhotoSize | null = null;
            let maxSize = 0;

            for (const size of photo.sizes) {
                let sizeBytes = 0;
                if (size instanceof Api.PhotoSize) {
                    sizeBytes = size.size;
                } else if (size instanceof Api.PhotoCachedSize) {
                    sizeBytes = size.bytes.length;
                } else if (size instanceof Api.PhotoStrippedSize) {
                    sizeBytes = size.bytes.length;
                } else if (size instanceof Api.PhotoSizeProgressive) {
                    sizeBytes = size.sizes.sort((a, b) => b - a)[0];
                } else if (size instanceof Api.PhotoPathSize) {
                    sizeBytes = size.bytes.length;
                }

                if (sizeBytes > maxSize) {
                    maxSize = sizeBytes;
                    largestSize = size;
                }
            }

            if (!largestSize || !(largestSize instanceof Api.PhotoSize || largestSize instanceof Api.PhotoSizeProgressive)) {
                return null;
            }

            // Get the type string for thumbSize - PhotoSizeProgressive doesn't have a 'type' property
            let thumbSize = '';
            if (largestSize instanceof Api.PhotoSize) {
                thumbSize = largestSize.type || '';
            }

            const location = new Api.InputPhotoFileLocation({
                id: photo.id,
                accessHash: photo.accessHash,
                fileReference: photo.fileReference,
                thumbSize: thumbSize,
            });

            return {
                location,
                size: maxSize,
                dcId: photo.dcId,
            };
        } else if (media instanceof Api.MessageMediaDocument) {
            const document = media.document as Api.Document;
            if (!document || !(document instanceof Api.Document)) {
                return null;
            }

            const location = new Api.InputDocumentFileLocation({
                id: document.id,
                accessHash: document.accessHash,
                fileReference: document.fileReference,
                thumbSize: '',
            });

            return {
                location,
                size: document.size.toJSNumber(),
                dcId: document.dcId,
            };
        }

        return null;
    }

    /**
     * Download file using multiple concurrent connections (memory-optimized)
     * Uses ordered streaming to write chunks to memory as they complete
     * Limits memory usage to approximately chunkSize * threads
     */
    private async downloadFileAccelerated(
        location: Api.TypeInputFileLocation,
        totalSize: number,
        dcId: number | undefined,
        progressCallback?: ProgressCallback
    ): Promise<Buffer> {
        const threads = Math.min(this.config.downloadThreads, 8);
        const chunkSize = this.config.chunkSize;

        // Calculate chunks
        const chunks: ChunkTask[] = [];
        for (let offset = 0; offset < totalSize; offset += chunkSize) {
            const limit = Math.min(chunkSize, totalSize - offset);
            chunks.push({ offset, limit, retries: 0 });
        }

        // Buffer to store downloaded chunks (limited by concurrent threads)
        const buffers: { [key: number]: Buffer } = {};
        const orderedBuffers: Buffer[] = [];
        let downloadedBytes = 0;
        let nextExpectedOffset = 0;
        let activeDownloads = 0;
        const maxConcurrent = threads;

        // Sender for the correct DC (may change if file is on different DC)
        let sender: MTProtoSender | undefined;
        if (dcId !== undefined) {
            sender = await this.client.getSender(dcId);
        }

        // Progress tracking
        const updateProgress = () => {
            if (progressCallback) {
                progressCallback(
                    bigInt(downloadedBytes),
                    bigInt(totalSize)
                );
            }
        };

        // Process ordered chunks and free memory
        const processOrderedChunks = () => {
            while (buffers[nextExpectedOffset]) {
                const buffer = buffers[nextExpectedOffset];
                orderedBuffers.push(buffer);
                delete buffers[nextExpectedOffset]; // Free memory immediately
                nextExpectedOffset += chunkSize;
            }
        };

        // Download chunks with concurrency control
        const downloadChunk = async (task: ChunkTask): Promise<void> => {
            activeDownloads++;
            try {
                const request = new Api.upload.GetFile({
                    location: location,
                    offset: bigInt(task.offset),
                    limit: task.limit,
                    precise: true,
                });

                // Use sender if available (for correct DC), otherwise use default client
                const result = sender
                    ? await this.client.invokeWithSender(request, sender)
                    : await this.client.invoke(request);

                if (result instanceof Api.upload.File) {
                    buffers[task.offset] = result.bytes;
                    downloadedBytes += result.bytes.length;
                    updateProgress();
                    processOrderedChunks();
                }
            } catch (error) {
                // Handle FileMigrateError - file is on a different DC
                if (error instanceof FileMigrateError) {
                    if (this.logger) {
                        this.logger.info(`File lives in DC ${error.newDc}, switching sender`);
                    }
                    // Get sender for the correct DC and retry
                    sender = await this.client.getSender(error.newDc);
                    activeDownloads--;
                    return await downloadChunk(task);
                }

                // Retry logic for other errors
                if (task.retries < this.config.maxRetries) {
                    task.retries++;
                    if (this.logger) {
                        this.logger.warn(`Chunk at offset ${task.offset} failed, retrying (${task.retries}/${this.config.maxRetries})`);
                    }
                    await this.sleep(1000 * task.retries); // Exponential backoff
                    activeDownloads--;
                    return await downloadChunk(task);
                } else {
                    throw new Error(`Failed to download chunk at offset ${task.offset} after ${this.config.maxRetries} retries: ${error}`);
                }
            } finally {
                activeDownloads--;
            }
        };

        // Download all chunks with concurrency control
        const downloadPromises: Promise<void>[] = [];
        for (const chunk of chunks) {
            // Wait if we've hit max concurrent downloads
            while (activeDownloads >= maxConcurrent) {
                await this.sleep(50);
            }
            downloadPromises.push(downloadChunk(chunk));
        }

        // Wait for all downloads to complete
        await Promise.all(downloadPromises);

        // Ensure all ordered chunks are processed
        processOrderedChunks();

        // Combine all chunks into a single buffer
        const finalBuffer = Buffer.concat(orderedBuffers);

        return finalBuffer;
    }

    /**
     * Download file with streaming to disk (memory-efficient for large files)
     */
    async downloadMediaToFile(
        media: Api.TypeMessageMedia,
        filePath: string,
        progressCallback?: ProgressCallback
    ): Promise<void> {
        // If acceleration is disabled, fall back to standard download
        if (!this.config.enableDownloadAcceleration) {
            const result = await this.client.downloadMedia(media, {
                progressCallback: progressCallback,
            });
            const buffer = Buffer.isBuffer(result) ? result : Buffer.from(result as string);
            await fs.writeFile(filePath, buffer);
            return;
        }

        // Get file information
        const fileInfo = this.getFileInfo(media);
        if (!fileInfo) {
            // Fall back to standard download
            const result = await this.client.downloadMedia(media, {
                progressCallback: progressCallback,
            });
            const buffer = Buffer.isBuffer(result) ? result : Buffer.from(result as string);
            await fs.writeFile(filePath, buffer);
            return;
        }

        const { location, size, dcId } = fileInfo;

        // For small files, use standard download
        if (size < 1024 * 1024) {
            const result = await this.client.downloadMedia(media, {
                progressCallback: progressCallback,
            });
            const buffer = Buffer.isBuffer(result) ? result : Buffer.from(result as string);
            await fs.writeFile(filePath, buffer);
            return;
        }

        // Stream to file for large files
        await this.downloadFileToStream(
            location,
            size,
            dcId,
            filePath,
            progressCallback
        );
    }

    /**
     * Download file directly to stream with concurrent downloads and backpressure handling
     * Most memory-efficient approach for large files
     */
    private async downloadFileToStream(
        location: Api.TypeInputFileLocation,
        totalSize: number,
        dcId: number | undefined,
        filePath: string,
        progressCallback?: ProgressCallback
    ): Promise<void> {
        const writeStream = createWriteStream(filePath);
        const threads = Math.min(this.config.downloadThreads, 8);
        const chunkSize = this.config.chunkSize;

        // Calculate chunks
        const chunks: ChunkTask[] = [];
        for (let offset = 0; offset < totalSize; offset += chunkSize) {
            const limit = Math.min(chunkSize, totalSize - offset);
            chunks.push({ offset, limit, retries: 0 });
        }

        // Buffer for ordering chunks (limit memory usage)
        const buffers: { [key: number]: Buffer } = {};
        let downloadedBytes = 0;
        let writtenBytes = 0;
        let nextWriteOffset = 0;
        let activeDownloads = 0;
        let bufferedChunks = 0; // Track number of chunks in memory
        const maxConcurrent = threads;
        let writeError: Error | null = null;

        // Sender for the correct DC (may change if file is on different DC)
        let sender: MTProtoSender | undefined;
        if (dcId !== undefined) {
            sender = await this.client.getSender(dcId);
        }

        // Progress tracking
        const updateProgress = () => {
            if (progressCallback) {
                progressCallback(
                    bigInt(downloadedBytes),
                    bigInt(totalSize)
                );
            }
        };

        // Handle backpressure - wait for drain event if too many chunks are buffered
        const waitForDrain = (): Promise<void> => {
            const bufferedSize = bufferedChunks * chunkSize;
            if (writeStream.writableHighWaterMark && bufferedSize > writeStream.writableHighWaterMark) {
                return new Promise((resolve) => {
                    writeStream.once('drain', resolve);
                });
            }
            return Promise.resolve();
        };

        // Write ordered chunks to stream
        const writeOrderedChunks = async () => {
            while (buffers[nextWriteOffset] && !writeError) {
                const buffer = buffers[nextWriteOffset];
                
                // Handle backpressure
                const canContinue = writeStream.write(buffer);
                writtenBytes += buffer.length;
                
                delete buffers[nextWriteOffset]; // Free memory immediately
                bufferedChunks--; // Decrement buffer count
                nextWriteOffset += chunkSize;

                if (!canContinue) {
                    await waitForDrain();
                }
            }
        };

        // Download chunk with retry logic
        const downloadChunk = async (task: ChunkTask): Promise<void> => {
            activeDownloads++;
            try {
                const request = new Api.upload.GetFile({
                    location: location,
                    offset: bigInt(task.offset),
                    limit: task.limit,
                    precise: true,
                });

                // Use sender if available (for correct DC), otherwise use default client
                const result = sender
                    ? await this.client.invokeWithSender(request, sender)
                    : await this.client.invoke(request);

                if (result instanceof Api.upload.File) {
                    buffers[task.offset] = result.bytes;
                    bufferedChunks++; // Increment buffer count
                    downloadedBytes += result.bytes.length;
                    updateProgress();
                    
                    // Try to write ordered chunks
                    await writeOrderedChunks();
                }
            } catch (error) {
                // Handle FileMigrateError - file is on a different DC
                if (error instanceof FileMigrateError) {
                    if (this.logger) {
                        this.logger.info(`File lives in DC ${error.newDc}, switching sender`);
                    }
                    // Get sender for the correct DC and retry
                    sender = await this.client.getSender(error.newDc);
                    activeDownloads--;
                    return await downloadChunk(task);
                }

                // Retry logic for other errors
                if (task.retries < this.config.maxRetries) {
                    task.retries++;
                    if (this.logger) {
                        this.logger.warn(`Chunk at offset ${task.offset} failed, retrying (${task.retries}/${this.config.maxRetries})`);
                    }
                    await this.sleep(1000 * task.retries);
                    activeDownloads--;
                    return await downloadChunk(task);
                } else {
                    writeError = new Error(`Failed to download chunk at offset ${task.offset} after ${this.config.maxRetries} retries: ${error}`);
                    throw writeError;
                }
            } finally {
                activeDownloads--;
            }
        };

        // Download all chunks with concurrency control
        const downloadPromises: Promise<void>[] = [];
        
        for (const chunk of chunks) {
            if (writeError) break;
            
            // Wait if we've hit max concurrent downloads or too many buffered chunks
            while ((activeDownloads >= maxConcurrent || bufferedChunks >= maxConcurrent * 2) && !writeError) {
                await this.sleep(50);
                await writeOrderedChunks(); // Try to write while waiting
            }
            
            downloadPromises.push(downloadChunk(chunk));
        }

        try {
            // Wait for all downloads to complete
            await Promise.all(downloadPromises);

            // Write any remaining ordered chunks
            await writeOrderedChunks();

            // Close the stream
            return new Promise((resolve, reject) => {
                writeStream.end(() => {
                    if (writeError) {
                        reject(writeError);
                    } else {
                        resolve();
                    }
                });
                writeStream.on('error', reject);
            });
        } catch (error) {
            writeStream.end();
            throw error;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
