import queue from 'async/queue';
import { Statement } from 'better-sqlite3';
import Cron from 'croner';
import { mkdirSync, writeFileSync } from 'fs';
import input from 'input';
import mimetics from 'mimetics';
import minimist from 'minimist';
import { Api, Logger, TelegramClient } from 'telegram';
import { LogLevel } from 'telegram/extensions/Logger';
import { StringSession } from 'telegram/sessions';
import { Dialog } from 'telegram/tl/custom/dialog';
import xbytes from 'xbytes';

import { Tonfig } from '@liesauer/tonfig';

import { Db } from './db';
import {
    array2dictionary, consoletable, DataDir, ellipsisLeft, ellipsisMiddle, md5, sanitizeFolderName, waitForever,
    waitTill
} from './functions';
import { MenuSystem, GroupInfo } from './menu';
import { AnnotatedDictionary, UnwrapAnnotatedDictionary } from './types';
import { AcceleratedDownloader, DownloadConfig } from './downloader';
import { uiStateManager } from './uiStateManager';
import { globalEventBus } from './eventBus';
import { FolderStructureManager } from './folderStructureManager';

const argv = minimist(process.argv.slice(2));

const logFile = DataDir() + '/channels.txt';

class MyLogger extends Logger {
    public format(message: string, level: string, messageFormat?: string) {
        return (messageFormat || this.messageFormat)
            .replace("%t", this.getDateTime())
            .replace("%l", level.toUpperCase())
            .replace("%m", message);
    }
    public log(level: LogLevel, message: string, color: string) {
        let multiLine = message.includes("\n");
        let messageFormat = "";

        if (multiLine) {
            messageFormat = "[%t] [%l]\n%m";
        } else {
            messageFormat = "[%t] [%l] - %m";
        }

        const log = color + this.format(message, level, messageFormat) + this['colors'].end;

        // Output logs to console when:
        // 1. In menu state (menu will handle display)
        // 2. uiTimer is not active (paused or not started)
        // When uiTimer is active and not in menu, render() handles log display
        if (uiStateManager.isInMenu() || !uiTimer || uiTimer['_states'].paused) {
            console.log(log);
        }

        addLogHistory(log, message);
    }
}

function addLogHistory(message: string, raw: string) {
    if (logHistory.length && logHistory[logHistory.length - 1].includes(raw)) {
        logHistory[logHistory.length - 1] = message;
        return;
    }

    const messageLines = message.split("\n");

    if (messageLines.length == maxLogHistory) {
        logHistory = messageLines;
    } else if (messageLines.length > maxLogHistory) {
        logHistory = messageLines.slice(messageLines.length  - maxLogHistory);
    } else {
        for (const message of messageLines) {
            if (logHistory.length >= maxLogHistory) {
                logHistory.shift();
            }
            logHistory.push(message);
        }
    }
}

function workerErrorHandler(error: any, job: Cron) {
    logger.error(`「${job.name}」任务过程中发生错误：\n${error}`);
};

async function GetChannels<T = Api.PeerChannel>(ids: T[]): Promise<Api.TypeChat[]> {
    if (!ids.length) return [];

    // return client.invoke(new Api.channels.GetChannels({
    //     id: ids as Api.PeerChannel[],
    // })).then(v => v.chats);

    const _get = async <T = any>(ids: T[]) => {
        if (!ids.length) return [];

        return client.invoke(new Api.channels.GetChannels({
            id: ids as Api.PeerChannel[],
        })).then<Api.TypeChat[], Api.TypeChat[]>(v => v.chats, async _ => {
            if (ids.length < 2) return [];

            const mid   = Math.ceil(ids.length / 2);
            const part1 = ids.slice(0, mid);
            const part2 = ids.slice(mid);

            return [
                ...await GetChannels<T>(part1),
                ...await GetChannels<T>(part2),
            ];
        });
    };

    return await _get<T>(ids);
}

async function getChannelInfos(client: TelegramClient) {
    let dialogs: Dialog[] = [];

    /**
     * https://github.com/gram-js/gramjs/issues/785
     * 
     * node_modules/telegram/client/dialogs.js#L129
     * 
     * if (!message) continue;
     */
    for await (const dialog of client.iterDialogs()) {
        dialogs.push(dialog);
    }

    const ids = dialogs.map(v => v.dialog.peer).filter(v => v.className == "PeerChannel").map(v => v as Api.PeerChannel);

    const idsMap = array2dictionary(ids, (i, e) => {
        return { key: e.channelId.toString(), value: e };
    });

    const channels = await GetChannels(ids);

    const chats = channels.filter(v => v.className == "Channel").map(v => v as Api.Channel);

    const getTopics = (topics: Api.messages.ForumTopics) => {
        return topics.topics.filter(v => v.className == "ForumTopic").map(v => v as Api.ForumTopic).map(v => ({
            id:    v.id,
            title: v.title,
        }));
    };

    const infos = chats.map(chat => {
        return {
            id:       chat.id || "",
            peer:     idsMap[chat.id.toString()] || "",
            title:    chat.title,
            forum:    chat.forum,
            username: chat.username,
            topics:   [] as ReturnType<typeof getTopics>,
        };
    });

    await Promise.allSettled(infos.filter(v => v.forum).map(async v => {
        return client.invoke(
            new Api.channels.GetForumTopics({
                channel: v.peer,
            })
        ).then(topics => ({ topics, channel: v }));
    })).then(results => {
        for (const result of results) {
            if (result.status == "rejected") continue;

            result.value.channel.topics = getTopics(result.value.topics);
        }
    });

    infos.unshift({
        id:       "me",
        peer:     "me",
        title:    "Saved Messages",
        forum:    false,
        username: "",
        topics:   [],
    });

    return infos;
}

/**
 * @param lastId 获取此条信息以后的信息
 * @param limit 每次获取多少信息（最大100）
 * @param newStrategy 当采集新的群组时（既没有`lastId`），历史信息采集策略
 * 
 * -1：采集所有历史信息，0：不采集任何历史信息，正数字：采集最后指定数量信息
 */
async function getChannelMessages(client: TelegramClient, channelId: string, lastId?: number, limit: number = 100, newStrategy: number = -1) {
    let messages: Api.MessageService[] = [];

    if (lastId) {
        do {
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    addOffset: -1 - limit,
                    offsetId: lastId,
                    limit: limit,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                messages.push(..._messages.messages.map(v => v as Api.MessageService).reverse());
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);
    } else if (newStrategy === -1) {
        let page = 0;

        do {
            // 第一次获取第一条信息，后面正常取
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    offsetId: 1,
                    addOffset: -1,
                    limit: 1,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            page++;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                messages.push(..._messages.messages.map(v => v as Api.MessageService));
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;
            if (newStrategy && newStrategy !== -1 && messages.length >= newStrategy) {
                messages = messages.slice(0, newStrategy);
                break;
            }

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);

        messages.reverse();
    } else if (newStrategy >= 0) {
        let page = 0;

        do {
            const _messages = await client.invoke(
                new Api.messages.GetHistory({
                    peer: channelId,
                    addOffset: page * limit,
                    limit: newStrategy === 0 ? 1 : limit,
                })
            ) as Exclude<Api.messages.TypeMessages, Api.messages.MessagesNotModified>;

            page++;

            if (_messages.messages.length) {
                // 最新的消息在数组前面
                lastId = _messages.messages[0].id;

                if (newStrategy !== 0) {
                    messages.push(..._messages.messages.map(v => v as Api.MessageService));
                }
            }

            if (!_messages.messages.length || _messages.messages.length < limit) break;
            if (newStrategy && newStrategy !== -1 && messages.length >= newStrategy) {
                messages = messages.slice(0, newStrategy);
                break;
            }

            // 只获取一页，由外部控制增量抓取
            break;
        } while (true);

        messages.reverse();
    }

    return { lastId: lastId || 0, messages };
}

function shouldDownload(channelId: string, media: Api.TypeMessageMedia, type: "photo" | "video" | "audio" | "file") {
    let sizeNum: number;

    if (media instanceof Api.MessageMediaPhoto) {
        const photo = media.photo as Api.Photo;

        if (photo?.sizes?.length) {
            sizeNum = photo.sizes.map(v => {
                if (v instanceof Api.PhotoSize) {
                    return v.size;
                } else if (v instanceof Api.PhotoCachedSize) {
                    return v.bytes.length;
                } else if (v instanceof Api.PhotoStrippedSize) {
                    return v.bytes.length;
                } else if (v instanceof Api.PhotoSizeProgressive) {
                    return v.sizes.sort((a, b) => b - a)[0];
                } else if (v instanceof Api.PhotoPathSize) {
                    return v.bytes.length;
                }
            }).sort((a, b) => b - a)[0];
        }
    } else if (media instanceof Api.MessageMediaDocument) {
        const document = media.document as Api.Document;

        if (document?.size) {
            sizeNum = document.size.toJSNumber();
        }
    }

    // 暂时不识别的文件，宁愿多下载也不要缺
    if (sizeNum == null) return true;

    const limit1 = tonfig.get<string>(['filter', type, channelId], '');
    const limit2 = tonfig.get<string>(['filter', 'default', type], '');

    const limit = `${limit1 || limit2}`.split('-');

    // 格式：下限-上限，示例：10240-999999999，单位：字节
    if (limit.length == 2) {
        const num1 = Number(limit[0]);
        const num2 = Number(limit[1]);

        if (!isNaN(num1) && !isNaN(num2)) {
            const min = Math.min(num1, num2);
            const max = Math.max(num1, num2);

            if (sizeNum < min || sizeNum > max) {
                return false;
            }
        }
    }

    // if (sizeNum != null) {
    //     const tSize = xbytes(sizeNum);

    //     addLogHistory(tSize, tSize);
    // }

    return true;
}

async function downloadChannelMedia(client: TelegramClient, channelId: string, message: Api.MessageService, channelInfo: UnwrapAnnotatedDictionary<typeof waitQueue>, medias?: string[], groupMessage?: boolean, saveRawMessage?: boolean) {
    const photo = message.photo as Api.Photo;
    const video = message.video as Api.Document;
    const audio = message.audio as Api.Document;
    const file  = message.document && message.document.attributes.length == 1 && message.document.attributes[0].className == "DocumentAttributeFilename" ? message.file : null;

    /**
     * MessageService：修改频道头像、信息等等
     */
    const className = message.className as string;
    
    if (className != "Message") return;

    const messageId      = message.id ? message.id.toString() : '';
    const groupedId      = message.groupedId ? message.groupedId.toString() : '';
    const _replyId       = message.replyTo?.replyToTopId || message.replyTo?.replyToMsgId || message.replyToMsgId;
    let topicId          = (message.replyTo?.forumTopic && _replyId) ? _replyId.toString() : '';
    channelId            = channelId || '';
    let commentChannelId = '';

    if (channelInfo.forum && !topicId) {
        topicId = '1';
    }

    /**
     * 消息评论是需要在一个专门的频道承载的
     */
    if (message['comment']) {
        commentChannelId = (<Api.PeerChannel>message.peerId).channelId.toString();
    }

    let msg_uid = '';

    if (commentChannelId) {
        msg_uid = md5(`${channelId}_${topicId}_${commentChannelId}_${messageId}_${groupedId}`);
    } else {
        msg_uid = md5(`${channelId}_${topicId}_${messageId}_${groupedId}`);
    }

    let querySatement: Statement;
    let insertSatement: Statement;
    let updateSatement: Statement;

    if (saveRawMessage) {
        if (!downloadChannelMedia['_querySatement']) {
            downloadChannelMedia['_querySatement'] = database.prepare("SELECT id FROM message WHERE uniqueId = ?");
        }
        if (!downloadChannelMedia['_insertSatement']) {
            downloadChannelMedia['_insertSatement'] = database.prepare("INSERT INTO message (uniqueId, channelId, topicId, messageId, groupedId, text, rawMessage, fileName, savePath, date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        }
        if (!downloadChannelMedia['_updateSatement']) {
            downloadChannelMedia['_updateSatement'] = database.prepare("UPDATE message SET fileName = ?, savePath = ? WHERE uniqueId = ?");
        }

        querySatement = downloadChannelMedia['_querySatement'];
        insertSatement = downloadChannelMedia['_insertSatement'];
        updateSatement = downloadChannelMedia['_updateSatement'];

        if (!querySatement.get(msg_uid)) {
            const rawMessage = JSON.stringify(message);

            insertSatement.run(msg_uid, channelId, topicId, messageId, groupedId, message.rawText || '', rawMessage, '', '', message.date || 0);
        }
    }

    let rawFileName = '';
    let fullFileName = '';
    let absSavePath = '';

    // Helper function to download a specific media type
    const downloadMedia = async (
        mediaType: 'photo' | 'video' | 'audio' | 'file',
        defaultExtension: string
    ) => {
        let media = message.media as Api.MessageMediaDocument;

        if (!shouldDownload(channelId, media, mediaType)) {
            return;
        }

        // Get extension from mime type or filename
        let ext = '';
        if (message?.file) {
            ext = Object.keys(mimetics.mimeTypeMap).find(v => {
                return mimetics.mimeTypeMap[v] == message.file.mimeType;
            }) || '';
        }

        // Get raw filename if exists
        if (media?.document) {
            const document = media.document as Api.Document;
            const filenameAttr = document.attributes.find(v => v.className == "DocumentAttributeFilename") as Api.DocumentAttributeFilename;
            if (filenameAttr && filenameAttr.fileName) {
                rawFileName = filenameAttr.fileName;
            }
        }

        // Build folder path and filename using FolderStructureManager
        const folderOptions = {
            channelId,
            channelTitle: channelInfo.channelTitle,
            topicId,
            groupedId,
            messageId,
            mediaType,
        };

        const dir = folderStructureManager.buildFolderPath(folderOptions);
        mkdirSync(dir, { recursive: true });

        const filename = folderStructureManager.buildFilename({ ...folderOptions, rawFileName });
        
        // Determine if filename already has extension
        const hasExt = rawFileName && rawFileName.lastIndexOf('.') > Math.max(rawFileName.lastIndexOf('/'), rawFileName.lastIndexOf('\\'));
        fullFileName = hasExt ? filename : `${filename}.${ext || defaultExtension}`;

        channelInfo.fileName = fullFileName;
        absSavePath = `${dir}/${fullFileName}`;

        // Download the media directly to file (memory-efficient, avoids loading entire file into memory)
        await acceleratedDownloader.downloadMediaToFile(message.media, absSavePath, (bytes, total) => {
            channelInfo.downloadedBytes = bytes;
            channelInfo.totalBytes = total;
        });
    };

    // Download each media type using the unified function
    if (photo && (!medias || medias.includes('photo'))) {
        await downloadMedia('photo', 'jpg');
    }

    if (video && (!medias || medias.includes('video'))) {
        await downloadMedia('video', 'mp4');
    }

    if (audio && (!medias || medias.includes('audio'))) {
        await downloadMedia('audio', 'mp3');
    }

    if (file && (!medias || medias.includes('file'))) {
        await downloadMedia('file', 'dat');
    }

    if (saveRawMessage && (rawFileName || absSavePath)) {
        const savePath = absSavePath.replace(DataDir() + '/', '');

        updateSatement.run(rawFileName, savePath, msg_uid);
    }
}

const listChannels = !!argv['list'];
let channelTable: {
    ID: string,
    频道名: string,
}[] = [];
let maxLogHistory = 10;
let logHistory: string[] = [];

let logger: Logger = new MyLogger();
let client: TelegramClient;
let tonfig: Tonfig;
let menuSystem: MenuSystem;
let acceleratedDownloader: AcceleratedDownloader;
let folderStructureManager: FolderStructureManager;

let uiTimer: Cron;
let mainTimer: Cron;
let mediaSpiderTimer: Cron;

let database: Db;

let channelInfos: Awaited<ReturnType<typeof getChannelInfos>>;

const waitQueue: AnnotatedDictionary<{
    channelId: string,
    channelTitle: string,
    forum: boolean,
    topics: {
        id: number,
        title: string,
    }[],
    downloading: boolean,
    fileName: string,
    downloadedBytes: bigInt.BigInteger,
    totalBytes: bigInt.BigInteger,
    messages: Api.MessageService[],
    medias: string[],
    lastDownloadTime: number,
}, "channelId"> = {};

let execQueue;

async function mediaSpider() {
    if (!isDownloading) return;
    
    await client.connect();

    const allowChannels = tonfig.get<string[]>('spider.channels', []);

    for (const channel of channelInfos) {
        const channelId = channel.id.toString();
        const channelTitle = channel.title || '';

        if (!allowChannels.includes(channelId)) continue;

        // Apply group filter
        if (!shouldProcessChannel(channelId)) continue;

        let medias = tonfig.get(['spider', 'medias', channelId], '');

        if (!medias) {
            medias = 'photo,video,audio,file';
            tonfig.set(['spider', 'medias', channelId], medias);
            await tonfig.save();
        }

        const mediasArr = medias.split(',').map(v => v.trim());

        if (!waitQueue[channelId]) {
            waitQueue[channelId] = {
                channelId: channelId,
                channelTitle: channelTitle,
                forum: channel.forum,
                topics: channel.topics || [],
                downloading: false,
                fileName: '',
                downloadedBytes: null,
                totalBytes: null,
                messages: [],
                medias: mediasArr,
                lastDownloadTime: 0,
            };
        }

        /**
         * 如果这个频道的数据还没有抓取完
         * 就不再抓取新的信息
         * 
         * 因为要保存频道的最后抓取位置
         * 单个频道只能一条一条消息按顺序解析下载
         * 
         * 只做多频道单消息同时下载
         * 不做单频道多消息同时下载
         */
        if (waitQueue[channelId].messages.length) continue;

        const lastId = tonfig.get(['spider', 'lastIds', channelId], 0);

        const messages = await getChannelMessages(client, channelId, lastId, undefined, -1);

        if (!lastId && !messages.messages.length) {
            const topId = messages.messages.length ? messages.messages[0].id : messages.lastId;
            tonfig.set(['spider', 'lastIds', channelId], topId);
            await tonfig.save();
        }

        for (const message of messages.messages) {
            waitQueue[channelId].messages.push(message);

            execQueue.push();

            // 消息评论
            if (message.replies?.replies && message.replies?.channelId) {
                const result = await client.invoke(
                    new Api.messages.GetReplies({
                    peer: message.peerId,
                    msgId: message.id,
                    limit: 2057604,
                    })
                ).catch(_ => null) as Api.messages.ChannelMessages;

                if (result && result.messages?.length) {
                    const comments = result.messages.reverse();

                    for (const comment of comments) {
                        waitQueue[channelId].messages.push(comment as Api.MessageService);

                        comment['comment'] = true;

                        execQueue.push();
                    }
                }
            }
        }
    }
}

async function render() {
    // Don't render when in menu state
    if (uiStateManager.isInMenu()) {
        return;
    }

    console.clear();

    if (listChannels) {
        if (channelTable && channelTable.length) {
            console.log(consoletable(channelTable));

            console.log(`完整列表已保存至：${logFile}`);

            uiTimer.stop();
            return;
        }

        return;
    }

    const downloading = Object.values(waitQueue).filter(v => v.downloading == true && v.totalBytes && !v.totalBytes.isZero());

    {
        if (!downloading.length) {
            downloading.push({
                channelId: '',
                channelTitle: '',
                forum: false,
                topics: [],
                downloading: true,
                fileName: '',
                downloadedBytes: null,
                totalBytes: null,
                messages: null,
                medias: null,
                lastDownloadTime: 0,
            });
        }

        const tableData = downloading.map(v => {
            const channelTitle = ellipsisMiddle(v.channelTitle, 10);
            const fileName = ellipsisLeft(v.fileName, 15);

            let size = '';
            let percent = '';

            if (v.totalBytes && !v.totalBytes.isZero()) {
                const downloaded = v.downloadedBytes.toJSNumber();
                const total = v.totalBytes.toJSNumber();

                const dSize = xbytes(downloaded);
                const tSize = xbytes(total);

                size = `${dSize}/${tSize}`;
                percent = (downloaded / total * 100).toFixed(2) + '%';
                percent = percent.padStart(6, ' ');
            }

            return {
                "频道": channelTitle,
                "文件名": fileName,
                "进度": percent,
                "大小": size,
            };
        });

        console.log(consoletable(tableData));
    }

    for (const log of logHistory) {
        console.log(log);
    }
}

async function loadConfig() {
    tonfig = await Tonfig.loadFile(DataDir() + '/config.toml', {
        account: {
            apiId: 0,
            apiHash: '',
            session: '',
            account: '',
            deviceModel: '',
            systemVersion: '',
            appVersion: '',
            langCode: '',
            systemLangCode: '',
        },

        spider: {
            concurrency: 5,
            channels: [],
            lastIds: {},
            medias: {
                _: "photo,video,audio,file",
            },
            groupMessage: false,
            saveRawMessage: false,
            enableDownloadAcceleration: true,
            downloadThreads: 5,
            chunkSize: 524288,
            maxRetries: 3,
        },

        filter: {
            default: {
                photo: "0-10737418240",
                video: "0-10737418240",
                audio: "0-10737418240",
                file:  "0-10737418240",
            },
            photo: {
                _: "0-10737418240",
            },
            video: {
                _: "0-10737418240",
            },
            audio: {
                _: "0-10737418240",
            },
            file: {
                _: "0-10737418240",
            },
        },

        fileOrganization: {
            enabled: false,
            createSubfolders: true,
        },

        proxy: {
            ip: "127.0.0.1",
            port: 0,
            username: "",
            password: "",
            MTProxy: false,
            secret: "",
            socksType: 5,
            timeout: 2,
        },
    });

    await tonfig.save();
}

function getAccountConfig() {
    const apiId = tonfig.get<number>("account.apiId");
    const apiHash = tonfig.get<string>("account.apiHash");
    const account = tonfig.get<string>("account.account");
    const session = tonfig.get<string>("account.session", "");

    const deviceModel = tonfig.get<string>("account.deviceModel", "");
    const systemVersion = tonfig.get<string>("account.systemVersion", "");
    const appVersion = tonfig.get<string>("account.appVersion", "");
    const langCode = tonfig.get<string>("account.langCode", "");
    const systemLangCode = tonfig.get<string>("account.systemLangCode", "");

    return { apiId, apiHash, account, session, deviceModel, systemVersion, appVersion, langCode, systemLangCode };
}

function getProxyConfig() {
    const ip = tonfig.get<string>("proxy.ip", "");
    const port = tonfig.get<number>("proxy.port", 0);
    const username = tonfig.get<string>("proxy.username", "");
    const password = tonfig.get<string>("proxy.password", "");
    const MTProxy = tonfig.get<boolean>("proxy.MTProxy", false);
    const secret = tonfig.get<string>("proxy.secret", "");
    const socksType = tonfig.get<5 | 4>("proxy.socksType", 5);
    const timeout = tonfig.get<number>("proxy.timeout", 2);

    return { ip, port, username, password, MTProxy, secret, socksType, timeout };
}

function parseCommaSeparatedList(input: string): string[] {
    if (!input || !input.trim()) return [];
    return input.split(',').map(id => id.trim()).filter(id => id);
}

function parseYesNoInput(input: string): boolean {
    const normalizedInput = input.trim().toLowerCase();
    return ['y', 'yes', 'true', '1'].includes(normalizedInput);
}

async function interactiveConfig() {
    logger.info('===== 首次配置向导 =====');
    logger.info('');
    
    // Step 1: API credentials
    logger.info('步骤 1/3: Telegram API 配置');
    logger.info('请访问 https://my.telegram.org/apps 获取 API ID 和 API Hash');
    
    let apiId: number;
    while (true) {
        const apiIdInput = await input.text('请输入 API ID: ');
        const parsed = parseInt(apiIdInput, 10);
        if (!isNaN(parsed) && parsed > 0) {
            apiId = parsed;
            break;
        }
        logger.warn('API ID 必须是有效的正整数，请重新输入');
    }
    
    const apiHash = await input.text('请输入 API Hash: ');
    
    // Step 2: Account
    logger.info('');
    logger.info('步骤 2/3: 账号配置');
    const account = await input.text('请输入 Telegram 账号（需要加上区号，例如: +861xxxxxxxxxx）: ');
    
    // Step 3: File organization
    logger.info('');
    logger.info('步骤 3/3: 文件分类存储');
    const enableOrgChoice = await input.text('是否按文件类型分类存储到子文件夹 (photo/, video/, audio/, file/)? (y/n, 默认: n): ');
    const enableOrganization = parseYesNoInput(enableOrgChoice);
    
    // Save configuration
    tonfig.set('account.apiId', apiId);
    tonfig.set('account.apiHash', apiHash);
    tonfig.set('account.account', account);
    tonfig.set('fileOrganization.enabled', enableOrganization);
    tonfig.set('fileOrganization.createSubfolders', true);
    
    await tonfig.save();
    
    logger.info('');
    logger.info('配置已保存！');
    logger.info('');
}

async function initializeGroupSelection() {
    logger.info('');
    logger.info('===== 群组选择 =====');
    logger.info('正在获取您的群组和频道列表...');
    logger.info('');
    
    const availableGroups: GroupInfo[] = channelInfos.map(ch => ({
        id: ch.id.toString(),
        title: ch.title,
        username: ch.username,
    }));
    
    const selectedIds = await menuSystem.selectGroups(availableGroups, []);
    
    if (selectedIds.length === 0) {
        logger.warn('您没有选择任何群组，请至少选择一个群组');
        await menuSystem.waitForKeyPress();
        return await initializeGroupSelection();
    }
    
    tonfig.set('spider.channels', selectedIds);
    await tonfig.save();
    
    logger.info('');
    menuSystem.showSuccess(`已保存 ${selectedIds.length} 个群组到配置文件`);
    
    // Set default media types
    const defaultMediaTypes = await menuSystem.selectFileTypes(['photo', 'video', 'audio', 'file']);
    if (defaultMediaTypes.length > 0) {
        tonfig.set(['spider', 'medias', '_'], defaultMediaTypes.join(','));
        await tonfig.save();
        menuSystem.showSuccess('已保存默认文件类型配置');
    }
    
    logger.info('');
    await menuSystem.waitForKeyPress();
}

async function addGroupsToSync() {
    const currentChannels = tonfig.get<string[]>('spider.channels', []);
    const availableGroups: GroupInfo[] = channelInfos
        .filter(ch => !currentChannels.includes(ch.id.toString()))
        .map(ch => ({
            id: ch.id.toString(),
            title: ch.title,
            username: ch.username,
        }));
    
    if (availableGroups.length === 0) {
        menuSystem.showError('没有可添加的群组（所有群组都已在同步列表中）');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    const selectedIds = await menuSystem.selectGroups(availableGroups, []);
    
    if (selectedIds.length === 0) {
        logger.info('未选择任何群组');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    const newChannels = [...currentChannels, ...selectedIds];
    tonfig.set('spider.channels', newChannels);
    await tonfig.save();
    
    menuSystem.showSuccess(`成功添加 ${selectedIds.length} 个群组`);
    await menuSystem.waitForKeyPress();
}

async function removeGroupsFromSync() {
    const currentChannels = tonfig.get<string[]>('spider.channels', []);
    
    if (currentChannels.length === 0) {
        menuSystem.showError('当前没有已同步的群组');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    const currentGroups: GroupInfo[] = channelInfos
        .filter(ch => currentChannels.includes(ch.id.toString()))
        .map(ch => ({
            id: ch.id.toString(),
            title: ch.title,
            username: ch.username,
        }));
    
    const selectedIds = await menuSystem.selectGroupsToRemove(currentGroups);
    
    if (selectedIds.length === 0) {
        logger.info('未选择任何群组');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    const confirmed = await menuSystem.confirmAction(`确定要移除 ${selectedIds.length} 个群组吗？`);
    if (!confirmed) {
        logger.info('已取消操作');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    const newChannels = currentChannels.filter(id => !selectedIds.includes(id));
    tonfig.set('spider.channels', newChannels);
    await tonfig.save();
    
    menuSystem.showSuccess(`成功移除 ${selectedIds.length} 个群组`);
    await menuSystem.waitForKeyPress();
}

async function reinitializeGroups() {
    const confirmed = await menuSystem.confirmAction('确定要清空当前配置并重新选择所有群组吗？');
    if (!confirmed) {
        logger.info('已取消操作');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    tonfig.set('spider.channels', []);
    await tonfig.save();
    
    await initializeGroupSelection();
}

async function handleGroupManagement() {
    while (true) {
        const currentChannels = tonfig.get<string[]>('spider.channels', []);
        const currentGroups: GroupInfo[] = channelInfos
            .filter(ch => currentChannels.includes(ch.id.toString()))
            .map(ch => ({
                id: ch.id.toString(),
                title: ch.title,
                username: ch.username,
            }));
        
        const choice = await menuSystem.showGroupManagementMenu(currentGroups);
        
        switch (choice) {
            case 'A':
                await addGroupsToSync();
                break;
            case 'R':
                await removeGroupsFromSync();
                break;
            case 'C':
                await reinitializeGroups();
                break;
            case '0':
                return;
        }
    }
}

async function handleFileTypeConfiguration() {
    const currentMediaTypes = tonfig.get<string>(['spider', 'medias', '_'], 'photo,video,audio,file');
    const currentTypes = currentMediaTypes.split(',').map(t => t.trim());
    
    const selectedTypes = await menuSystem.selectFileTypes(currentTypes);
    
    if (selectedTypes.length === 0) {
        menuSystem.showError('至少需要选择一种文件类型');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    tonfig.set(['spider', 'medias', '_'], selectedTypes.join(','));
    await tonfig.save();
    
    menuSystem.showSuccess('文件类型配置已保存');
    await menuSystem.waitForKeyPress();
}

async function handleOtherSettings() {
    while (true) {
        const choice = await menuSystem.showOtherSettingsMenu();
        
        switch (choice) {
            case '1': {
                const currentConcurrency = tonfig.get<number>('spider.concurrency', 5);
                const newConcurrency = await menuSystem.inputNumber(
                    '请输入并发下载数（同时下载的群组数量）:',
                    currentConcurrency
                );
                tonfig.set('spider.concurrency', newConcurrency);
                await tonfig.save();
                menuSystem.showSuccess(`并发数已设置为 ${newConcurrency}`);
                await menuSystem.waitForKeyPress();
                break;
            }
            case '2': {
                const currentEnabled = tonfig.get<boolean>('fileOrganization.enabled', false);
                const newEnabled = await menuSystem.toggleSetting(
                    '是否按文件类型分类存储到子文件夹?',
                    currentEnabled
                );
                tonfig.set('fileOrganization.enabled', newEnabled);
                await tonfig.save();
                menuSystem.showSuccess(`文件分类存储已${newEnabled ? '启用' : '禁用'}`);
                await menuSystem.waitForKeyPress();
                break;
            }
            case '3': {
                const currentGroupMessage = tonfig.get<boolean>('spider.groupMessage', false);
                const newGroupMessage = await menuSystem.toggleSetting(
                    '是否启用消息聚合（同一条消息的多个文件放在子文件夹中）?',
                    currentGroupMessage
                );
                tonfig.set('spider.groupMessage', newGroupMessage);
                await tonfig.save();
                menuSystem.showSuccess(`消息聚合已${newGroupMessage ? '启用' : '禁用'}`);
                await menuSystem.waitForKeyPress();
                break;
            }
            case '0':
                return;
        }
    }
}

function shouldProcessChannel(channelId: string): boolean {
    const allowChannels = tonfig.get<string[]>('spider.channels', []);
    return allowChannels.includes(channelId);
}

async function checkConfig() {
    await loadConfig();

    const { apiId, apiHash, account } = getAccountConfig();

    if (!apiId || !apiHash || !account) {
        await interactiveConfig();
        // Reload configuration after interactive setup
        await loadConfig();
    }
}

async function checkChannelConfig() {
    const allowChannels = tonfig.get<string[]>('spider.channels', []);

    if (!allowChannels?.length) {
        logger.info('');
        logger.info('首次使用需要选择要同步的群组');
        await initializeGroupSelection();
    }
}

let isDownloading = false;

async function startDownload() {
    if (isDownloading) {
        menuSystem.showError('下载已在进行中');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    const allowChannels = tonfig.get<string[]>('spider.channels', []);
    if (allowChannels.length === 0) {
        menuSystem.showError('没有配置要下载的群组，请先配置群组');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    isDownloading = true;
    
    // Start timers
    if (uiTimer && uiTimer['_states'].paused) {
        uiTimer.resume();
    }
    
    if (!mediaSpiderTimer) {
        mediaSpiderTimer = Cron("*/10 * * * * *", {
            name: 'mediaSpider',
            protect: true,
            catch: workerErrorHandler,
        }, async () => await mediaSpider());
    }
    
    const concurrency = tonfig.get<number>("spider.concurrency", 5);
    const groupMessage = tonfig.get<boolean>("spider.groupMessage", false);
    const saveRawMessage = tonfig.get<boolean>("spider.saveRawMessage", false);
    
    if (!execQueue) {
        execQueue = queue(async function(task, callback) {
            let channelInfo: UnwrapAnnotatedDictionary<typeof waitQueue>;

            await waitTill(() => {
                channelInfo = Object.values(waitQueue).filter(v => !v.downloading && v.messages.length).sort((a, b) => {
                    return a.lastDownloadTime - b.lastDownloadTime;
                })[0];

                return !!channelInfo;
            }, 1000);

            channelInfo.downloading = true;

            const channelId = channelInfo.channelId;
            const message = channelInfo.messages[0];
            const mediasArr = channelInfo.medias;

            await downloadChannelMedia(client, channelId, message, channelInfo, mediasArr, groupMessage, saveRawMessage).then(async () => {
                channelInfo.messages.shift();

                if (!message['comment']) {
                    // 下载成功，保存当前频道位置
                    tonfig.set(['spider', 'lastIds', channelId], message.id);
                    await tonfig.save();
                }
            }, () => {
                // 下载失败，啥也不用管，后面根据队列自动重试
            }).finally(() => {
                channelInfo.downloading = false;
                channelInfo.lastDownloadTime = Date.now();
                
                // Emit event to notify that download slot is available
                globalEventBus.emitEvent('download:complete');

                callback();
            });
        }, concurrency);
    }
    
    logger.info('下载已开始，正在后台运行...');
    logger.info('程序将返回主菜单，您可以随时停止下载或进行其他操作');
    await menuSystem.waitForKeyPress();
}

async function stopDownload() {
    if (!isDownloading) {
        menuSystem.showError('当前没有正在进行的下载');
        await menuSystem.waitForKeyPress();
        return;
    }
    
    isDownloading = false;
    
    // Stop timers
    if (mediaSpiderTimer) {
        mediaSpiderTimer.stop();
        mediaSpiderTimer = null;
    }
    
    if (uiTimer && !uiTimer['_states'].paused) {
        uiTimer.pause();
    }
    
    menuSystem.showSuccess('下载已停止');
    await menuSystem.waitForKeyPress();
}

async function main() {
    logger = new MyLogger();

    mkdirSync(DataDir(), { recursive: true });

    await checkConfig();
    
    menuSystem = new MenuSystem(logger, () => isDownloading);
    
    // Initialize folder structure manager
    folderStructureManager = new FolderStructureManager(tonfig);

    const saveRawMessage = tonfig.get<boolean>("spider.saveRawMessage", false);

    if (saveRawMessage) {
        database = Db.db();
    }

    let { apiId, apiHash, account, session, deviceModel, systemVersion, appVersion, langCode, systemLangCode } = getAccountConfig();

    if (!session) {
        logger.info('请按提示进行登录');
    }

    const proxy = getProxyConfig();

    client = new TelegramClient(new StringSession(session), apiId, apiHash, {
        baseLogger: logger,
        connectionRetries: 5,
        useWSS: false,
        proxy: proxy.ip && proxy.port ? proxy : undefined,
        deviceModel: deviceModel || undefined,
        systemVersion: systemVersion || undefined,
        appVersion: appVersion || undefined,
        langCode: langCode || "en",
        systemLangCode: systemLangCode || "en-US",
    });

    await client.start({
        phoneNumber: account,
        password: async () => await input.text("请输入密码："),
        phoneCode: async () => await input.text("请输入验证码："),
        onError: (err) => logger.error(err.message),
    });

    if (!session) {
        session = <string><unknown>client.session.save();
        tonfig.set("account.session", session);

        await tonfig.save();

        if (session) {
            logger.info('登录成功，登录状态会保持');
        } else {
            logger.info('登录失败');

            await waitForever();
        }
    }

    // Initialize accelerated downloader
    const downloadConfig: DownloadConfig = {
        enableDownloadAcceleration: tonfig.get<boolean>('spider.enableDownloadAcceleration', true),
        downloadThreads: tonfig.get<number>('spider.downloadThreads', 5),
        chunkSize: tonfig.get<number>('spider.chunkSize', 524288),
        maxRetries: tonfig.get<number>('spider.maxRetries', 3),
    };
    acceleratedDownloader = new AcceleratedDownloader(client, downloadConfig, logger);

    logger.info('获取频道信息中...');

    channelInfos = await getChannelInfos(client);

    channelTable = channelInfos.map(channel => {
        return {
            "ID": channel.id.toString(),
            "频道名": channel.title,
        };
    });

    {
        const maxIdLength = Math.max(...channelTable.map(v => v.ID.length));

        const logContent = channelTable.map(v => {
            const id = v.ID.padStart(maxIdLength, ' ');
            const title = v.频道名;

            return `${id}    ${title}`;
        }).join("\n");

        writeFileSync(logFile, logContent, {
            encoding: 'utf-8',
        });
    }

    if (saveRawMessage) {
        logger.info('保存频道信息到数据库中...');

        database.emptyTable('channel');

        const satement = database.prepare<string[]>("INSERT INTO channel (id, pid, title) VALUES (?, ?, ?)");

        for (const channelInfo of channelInfos) {
            const id = channelInfo.id.toString();
            const title = channelInfo.title || '';

            satement.run(id, '', title);

            for (const topic of channelInfo.topics) {
                const tid = topic.id.toString();
                const title = topic.title || '';

                satement.run(tid, id, title);
            }
        }
    }

    if (listChannels) {
        if (uiTimer) {
            uiTimer.resume();
        }
        // 等待render输出channelTable
        // 后面代码不再执行
        await waitForever();
    }

    // Check if channels are configured, if not, run first-time setup
    await checkChannelConfig();
    
    // Main menu loop
    while (true) {
        const choice = await menuSystem.showMainMenu();
        
        switch (choice) {
            case '1':
                await startDownload();
                break;
            case '2':
                await stopDownload();
                break;
            case '3':
                await handleGroupManagement();
                break;
            case '4':
                await handleFileTypeConfiguration();
                break;
            case '5':
                await handleOtherSettings();
                break;
            case '0':
                console.clear();
                logger.info('正在退出程序...');
                if (isDownloading) {
                    await stopDownload();
                }
                process.exit(0);
                break;
        }
    }
}

uiTimer = Cron("*/2 * * * * *", {
    name: 'ui',
    protect: true,
    paused: true,
    catch: workerErrorHandler,
}, async () => await render());

mainTimer = Cron("*/5 * * * *", {
    name: 'main',
    protect: true,
    catch: workerErrorHandler,
}, async () => await main());

mainTimer.trigger();
