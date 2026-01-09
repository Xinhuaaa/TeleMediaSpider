import { DataDir, sanitizeFolderName } from './functions';
import { Tonfig } from '@liesauer/tonfig';

/**
 * Folder Structure Manager
 * Centralized management of folder path generation logic
 * Eliminates code duplication and provides clear priority for folder organization
 * 
 * Priority order:
 * 1. Base folder: DataDir() + channelTitle (or channelId)
 * 2. Topic folder: _${topicId} (if forum and topicId exists)
 * 3. Group message folder: ${groupedId} (if groupMessage enabled and groupedId exists)
 * 4. File type folder: photo/video/audio/file (if fileOrganization enabled)
 */

export interface FolderOptions {
    channelId: string;
    channelTitle: string;
    topicId?: string;
    groupedId?: string;
    messageId?: string;
    mediaType?: 'photo' | 'video' | 'audio' | 'file';
}

export class FolderStructureManager {
    constructor(private tonfig: Tonfig) {}

    /**
     * Build the complete folder path for a media file
     * @param options Folder options
     * @returns Complete folder path
     */
    buildFolderPath(options: FolderOptions): string {
        const {
            channelId,
            channelTitle,
            topicId,
            groupedId,
            mediaType
        } = options;

        // Start with base directory: DataDir + channel folder
        const folderName = sanitizeFolderName(channelTitle) || channelId;
        let dir = `${DataDir()}/${folderName}`;

        // Add topic folder if exists
        if (topicId) {
            dir += `/_${topicId}`;
        }

        // Add grouped message folder if enabled
        const groupMessage = this.tonfig.get<boolean>('spider.groupMessage', false);
        if (groupMessage && groupedId) {
            dir += `/${groupedId}`;
        }

        // Add file type folder if file organization is enabled
        const fileOrgEnabled = this.tonfig.get<boolean>('fileOrganization.enabled', false);
        const createSubfolders = this.tonfig.get<boolean>('fileOrganization.createSubfolders', true);
        
        if (fileOrgEnabled && createSubfolders && mediaType) {
            dir += `/${mediaType}`;
        }

        return dir;
    }

    /**
     * Build the filename for a media file
     * @param options Filename options
     * @returns Filename without extension
     */
    buildFilename(options: FolderOptions & { rawFileName?: string }): string {
        const { messageId, groupedId, rawFileName } = options;

        const groupMessage = this.tonfig.get<boolean>('spider.groupMessage', false);
        
        let filename = `${messageId}`;

        // If group message is disabled, prepend groupedId to filename
        if (!groupMessage && groupedId) {
            filename = `${groupedId}_${filename}`;
        }

        // Append raw filename if exists
        if (rawFileName) {
            filename += `_${rawFileName}`;
        }

        return filename;
    }

    /**
     * Check if filename has an extension
     * @param filename Filename to check
     * @returns true if filename has an extension
     */
    private hasExtension(filename: string): boolean {
        if (!filename) return false;
        const lastDotIndex = filename.lastIndexOf('.');
        const lastSlashIndex = Math.max(
            filename.lastIndexOf('/'),
            filename.lastIndexOf('\\')
        );
        // Extension exists if dot comes after the last slash/backslash and is not the first character
        return lastDotIndex > lastSlashIndex && lastDotIndex > 0;
    }

    /**
     * Build complete file path
     * @param options File options
     * @param extension File extension (without dot)
     * @returns Complete file path
     */
    buildFilePath(
        options: FolderOptions & { rawFileName?: string },
        extension: string
    ): string {
        const dir = this.buildFolderPath(options);
        const filename = this.buildFilename(options);
        
        // If raw filename exists and already has extension, don't add another
        const hasExt = options.rawFileName && this.hasExtension(options.rawFileName);
        const fullFilename = hasExt ? filename : `${filename}.${extension}`;
        
        return `${dir}/${fullFilename}`;
    }
}
