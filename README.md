# TeleMediaSpider
Telegram 频道爬虫

![屏幕截图](screenshot.jpg)

# 初始化（开发）
```bash
yarn
```

# 如何调试（开发）
`VS Code` 中直接F5运行 `Launch`。

# 如何打包（开发）
`VS Code` 中运行 `pack executable` 任务，可执行文件会生成到 `output` 目录下。

<br />
<br />
<br />
<br />

# 如何使用

## 0. 下载
已打包好的TeleSpider可在这里下载：[https://github.com/liesauer/TeleMediaSpider/releases](https://github.com/liesauer/TeleMediaSpider/releases)，包含 `Windows x64` `Linux x64` `macOS x64` 多个版本，如需其他版本，请自行打包。

## 1. 首次运行
直接运行，根据提示进行账号配置，配置以下内容：
<br /><br />
`account.apiId`（参考文档，[Getting API ID and API HASH | GramJS](https://gram.js.org/getting-started/authorization#getting-api-id-and-api-hash)）
<br />
`account.apiHash`（参考文档，[Getting API ID and API HASH | GramJS](https://gram.js.org/getting-started/authorization#getting-api-id-and-api-hash)）
<br />
`account.account`（Telegram账号，**需要加上区号**，比如中国大陆就是：+861xxxxxxxxxx，其他区域同理）
<br />
~~`account.session`~~（这个不需要填，登录后自动保存）

无法申请 API （一直提示 ERROR 等）可以尝试这个教程，[另一种不需要 API ID 和 API HASH 的登录方式](https://github.com/liesauer/TGLogin/discussions/1)。

~~`account.deviceModel`~~（正常不需要填，使用无 API 方案建议填写）
<br />
~~`account.systemVersion`~~（正常不需要填，使用无 API 方案建议填写）
<br />
~~`account.appVersion`~~（正常不需要填，使用无 API 方案建议填写）
<br />
~~`account.langCode`~~（正常不需要填，使用无 API 方案建议填写）
<br />
~~`account.systemLangCode`~~（正常不需要填，使用无 API 方案建议填写）

配置保存后，根据提示进行登录（仅第一次需要）

## 2. 配置群组/频道列表

登录成功后，程序会自动获取您所有的 Telegram 群组和频道，并**以交互式复选框界面让您选择**要同步的群组。

- 使用 ↑↓ 方向键移动选项
- 使用空格键选择/取消选择群组
- 按 Enter 键确认选择

选择后会自动保存到配置文件中的 `spider.channels` 列表。

**频道id也会保存在频道列表文件 `data/channels.txt` 中供参考**

**如何抓取自己的已保存信息？**
<br />
使用固定的频道id：`me` 即可。

### 2.1 后续调整群组

程序启动后会显示主菜单，您可以随时进入"调整同步群组"功能：

**主菜单选项：**
```
[1] 开始下载 - 从保存的群组列表下载媒体
[2] 停止下载 - 停止当前的下载任务
[3] 调整同步群组 - 进入群组管理子菜单
[4] 文件类型配置 - 修改下载文件类型
[5] 其他设置 - 并发数、文件分类等
[0] 退出程序
```

**群组管理子菜单：**
```
[A] 添加群组到同步列表
[R] 移除某个群组
[C] 重新全选群组（重新初始化）
[0] 返回主菜单
```

### 2.2 配置下载的文件类型

在主菜单中选择"[4] 文件类型配置"，可以通过交互式复选框选择要下载的文件类型。

默认下载所有类型：`图片` `视频` `音频` `文件`

有效值：`photo` `video` `audio` `file`

如果你想为特定频道配置不同的文件类型，可以手动编辑 `data/config.toml`：

将以下配置

```toml
  [spider.medias]
  _ = "photo,video,audio,file"
```

修改为

```toml
  [spider.medias]
  _ = "photo,video,audio,file"
  频道id1 = "photo"
  频道id2 = "photo,video,audio,file"
```

## 3. 开始下载

配置完成后，在主菜单中选择"[1] 开始下载"即可开始抓取。程序会在后台运行，您可以：

- 随时返回主菜单查看其他选项
- 选择"[2] 停止下载"暂停下载
- 智能获取新消息，支持断点续抓
- 可以随时关闭软件，下次启动从断点继续

## 4. 其他设置

在主菜单中选择"[5] 其他设置"可以配置以下选项：

### 4.1 并发下载数设置
**注意：这并不是传统意义上的并发下载，而是指多频道同时下载，单一频道只能一条一条信息从前往后解析下载。**

默认为5个频道同时下载。可以在设置菜单中修改，或手动编辑配置文件：

```toml
[spider]
concurrency = 5
```

### 4.2 下载加速设置

TeleMediaSpider 现已支持类似 Telegram 第三方客户端的下载加速功能。通过多连接并发下载文件分块，可显著提升大文件下载速度（3-4倍），同时保持低内存占用（约10MB恒定）。

**功能特性：**
- ✓ 多连接并发下载（默认5个连接）
- ✓ 流式处理，内存友好
- ✓ 自动重试机制
- ✓ 实时进度跟踪
- ✓ 默认启用，无需额外配置

**配置说明：**

```toml
[spider]
# 下载加速配置
enableDownloadAcceleration = true    # 启用下载加速（默认：true）
downloadThreads = 5                  # 并发连接数 3-8（默认：5）
chunkSize = 524288                   # 分块大小，字节（默认：512KB）
maxRetries = 3                       # 分块失败重试次数（默认：3）
```

**性能对比：**
- **传统下载**：单线程，速度受限
- **加速下载**：多线程并发，速度提升 3-4 倍
- **内存占用**：恒定约 10MB，不随文件大小增加

**注意事项：**
- 小于 1MB 的文件自动使用标准下载（更高效）
- 建议 `downloadThreads` 保持在 3-8 之间
- 过高的并发数可能被服务器限制

### 4.3 文件分类存储设置

可以选择是否按文件类型分类存储到子文件夹（photo/, video/, audio/, file/）。

在设置菜单中可以切换开关，或手动编辑配置文件：

```toml
[fileOrganization]
enabled = true
createSubfolders = true
```

### 4.4 消息聚合设置

当开启消息聚合后，同一条消息中的多个文件会放在子文件夹中。

可以在设置菜单中切换开关，或手动编辑配置文件：

```toml
[spider]
groupMessage = true
```

## 5. 大小过滤
默认抓取大小不超过10GB的文件，如有需求，可按全局配置或按频道配置文件大小过滤。

格式：`下限-上限`
<br />
单位：`字节`
<br />
进制：`1024`
<br />
示例：`102400-10485760`
<br />
解释：抓取文件大小在 `100KB ~ 10MB` 之间的文件（含）

优先级：`频道配置 > 全局配置`

### 5.1. 全局配置
修改以下配置即可

```toml
[filter.default]
photo = "0-10737418240"
video = "0-10737418240"
audio = "0-10737418240"
file = "0-10737418240"
```

### 5.2. 频道配置
修改以下配置即可

```toml
[filter.photo]
频道id1 = "102400-999999999"

[filter.video]
频道id1 = "102400-999999999"

[filter.audio]
频道id1 = "102400-999999999"

[filter.file]
频道id1 = "102400-999999999"
```

## 代理设置

如果你所在的地区无法直连TG服务器，可使用代理进行连接

不支持 secret 以 `ee` 开头的 MTProxy，相关issue：[gram-js/gramjs#426](https://github.com/gram-js/gramjs/issues/426)

参考：
<br />
[Using MTProxies and Socks5 Proxies](https://gram.js.org/getting-started/authorization#using-mtproxies-and-socks5-proxies)

# 配置说明

**除了第一次配置账号信息，修改任意配置都需要重启软件生效**

**配置文件中所有的 `_` 配置项都是占位，用来当成示例配置供参考填写的，删除无实际影响。**

# 数据保存

## 自定义数据目录

默认情况下，所有数据（包括配置文件、登录状态、下载的媒体）都保存在程序目录下的 `data` 文件夹中。

**如果您希望在软件更新后保持登录状态和配置**，有以下两种方法：

### 方法一：保留 data 文件夹（推荐）
更新软件时，将旧版本的 `data` 文件夹复制到新版本程序目录下即可。

### 方法二：使用环境变量指定固定数据目录
设置环境变量 `TELE_SPIDER_DATA_DIR` 指向一个固定的目录，这样无论程序在哪里运行，数据都会保存在同一位置。

**Windows 设置方法：**
```cmd
set TELE_SPIDER_DATA_DIR=C:\Users\你的用户名\TeleMediaSpiderData
TeleMediaSpider.exe
```

或者在系统环境变量中永久设置。

**Linux/macOS 设置方法：**
```bash
export TELE_SPIDER_DATA_DIR=~/TeleMediaSpiderData
./TeleMediaSpider
```

或者添加到 `~/.bashrc` 或 `~/.zshrc` 中永久生效。

## 文件存储结构

默认下，同一条消息中的多张图片/文件会视为独立的文件，平级存放在数据文件夹中。
所有数据都保存在 `data/{频道名称}[/_{子组id}]` 文件夹下，文件名格式：`[{聚合id}_]{消息id}[_{原文件名}]`。

**注意：** 文件夹名称使用频道名称而非频道ID，特殊字符（如 `/\:*?"<>|`）会被替换为 `_`。如果频道名称为空，则使用频道ID作为文件夹名。

## 消息聚合
```toml
[spider]
groupMessage = true
```

当开启消息聚合后，这些文件会放在子文件夹中。
即保存在 `data/{频道名称}[/_{子组id}][/{聚合id}]` 文件夹下，文件名格式：`{消息id}[_{原文件名}]`。

## 原始数据保存
```toml
[spider]
saveRawMessage = true
```

当开启原始数据保存后，所有的频道列表、频道消息都会保存在 `data/database.db` sqlite3数据库中，以方便有二开或对接的需求。

### `channel` 表
| 字段  | 类型    | 说明               |
| ---   | ---    | ---                |
| id    | string | 频道id/子组id       |
| pid   | string | 父频道id（子组才有） |
| title | string | 频道名              |


### `message` 表
| 字段       | 类型    | 说明                                   |
| ---        | ---    | ---                                    |
| id         | number | 自增id                                 |
| uniqueId   | string | 内部使用                               |
| channelId  | string | 频道id                                 |
| topicId    | string | 子组id                                 |
| messageId  | string | 消息id                                 |
| groupedId  | string | 聚合id                                 |
| text       | string | 消息文本内容                            |
| rawMessage | string | 消息原始内容（JSON）                     |
| fileName   | string | 原文件名（一般只有文件才有，图片等不会有） |
| savePath   | string | 文件保存位置（相对于 `data` 文件夹）      |
| date       | number | 消息发送时间戳                           |
