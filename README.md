<div align="center">

# 墨办 InkTask

**眼前事，依次办 —— 深色系 Windows 本地待办**

[![Version](https://img.shields.io/badge/version-1.1.0-ffcc33?style=flat-square)](../../releases)
[![Platform](https://img.shields.io/badge/platform-Windows-0078d4?style=flat-square)](../../releases)
[![Electron](https://img.shields.io/badge/Electron-44-9feaf9?style=flat-square&logo=electron&logoColor=9feaf9)](https://www.electronjs.org/)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](./LICENSE)

[功能特性](#功能特性) · [下载安装](#下载安装) · [快速上手](#快速上手) · [从源码构建](#从源码构建) · [技术架构](#技术架构)

</div>

---

墨办是一款完全离线的 Windows 桌面待办软件。没有账号、没有云端、没有网络请求——所有数据只存在你自己的电脑上。专注做好一件事：**让你最急的事，永远排在最上面**。

![主界面](docs/images/shot-main.png)

## 功能特性

### 紧急度自动排序 + 到期倒计时

逾期 > 即将到期 > 高等级，任务列表实时按此排序，最紧急的永远在最上面。每张卡片右侧显示倒计时（`剩余 2小时15分` / `已逾期 3天`），跨过到期阈值时列表自动重排。

### 剪贴板图片直接内嵌

在任务详情或快速输入框里按 `Ctrl+V`，截图立即以内容流形式插入正文——所见即所得，不是附件列表。图片落盘于数据目录 `images/`，通过自定义 `inkimg://` 协议安全加载（仅允许该目录访问，防路径穿越）。

### 项目分组

![分组视图](docs/images/shot-work.png)

顶部分组条区分不同项目（工作 / 生活 / 任何你定义的），每个分组自动分配颜色。在「全部」视图下，任务卡片左侧显示分组色条，一眼可辨任务归属。浏览某个分组时新建的任务自动归入该分组，也可手动指定。

### 自绘日历选择器

![日历弹层](docs/images/shot-calendar.png)

点击「到期」弹出自绘日历：顶部快捷预设（今天 18:00 / 明天 09:00 / 下周一……）、周一开头的迷你日历（今天金色描边、翻月导航）、底部时/分步进器与整点快捷键。选好日期点「确定」生效，「清除到期」一键移除。

### 全局快捷键

任何应用中按都有效，可在设置中自定义组合键：

| 快捷键 | 作用 |
| --- | --- |
| `Ctrl+Shift+Space` | 显示 / 隐藏主面板 |
| `Ctrl+Shift+P` | 窗口置顶开关 |
| `Ctrl+F` | 筛选任务 |
| `Esc` | 关闭弹层 / 收起面板 |

### 更多细节

- **托盘常驻**：关窗只是隐藏到托盘，不占任务栏
- **可选行为**：失焦自动隐藏、到期系统通知、开机自启
- **三种强调色**：灯金 / 青碧 / 紫晶
- **备份**：设置面板一键导出 / 导入（zip 包含任务与全部内嵌图片，按任务 ID 合并，较新内容胜出）
- **防误删**：删除任务 5 秒内可撤销
- **数据安全**：JSON 原子写入（先写 `.tmp` 再 rename），断电不损坏

## 下载安装

| 产物 | 大小 | 适用场景 |
| --- | --- | --- |
| `InkTask-Portable-1.1.0.exe` | 99 MB | 单文件便携版，双击即用，U 盘可带走 |
| `InkTask-win64-1.1.0.zip` | 150 MB | 绿色解压版，适合放到固定目录长期使用 |

- **便携版**：双击后确认解压提示（首次约 10-30 秒），之后自动启动。
- **解压版**：解压到任意目录，运行 `墨办.exe`，可发送到桌面快捷方式，启动比便携版更快。

> 应用未做代码签名，首次运行 Windows SmartScreen 可能提示「未知发布者」，点击「仍要运行」即可。介意者可先下载 zip 版校验内容。

## 快速上手

1. **建一条任务**：在快速新增栏输入标题，回车。左侧药丸点按切换紧急度（低/中/高/急），右侧「到期」设置截止时间，中间可选分组。
2. **补充详情**：点击任务卡片展开，直接编辑富文本，`Ctrl+V` 贴图。
3. **分组管理**：分组条末端「＋」打开管理面板——新建（回车确认）、双击重命名、删除（其任务自动移入未分组，不会丢失）。
4. **完成与清理**：点卡片圆形勾选完成；底部「清除已完成」一键清理。
5. **快捷呼出**：任何时候 `Ctrl+Shift+Space` 呼出或隐藏面板，`Ctrl+Shift+P` 保持置顶边看边办。

## 从源码构建

环境要求：Node.js 18+（构建 Windows 产物在 Linux 上亦可交叉完成）。

```bash
git clone https://github.com/zhouxingbudai/InkTask.git
cd InkTask
npm install

npm start        # 开发运行
npm test         # 单元测试（排序 / 存储 / 倒计时）
npm run dist     # Windows 上产出 NSIS 安装包 + 便携版
npm run dist:dir # 任意平台产出 dist/win-unpacked/ 可运行目录
```

无 Node 环境时，浏览器直接打开 `renderer/index.html?demo=1` 可预览 UI（数据存 localStorage，贴图功能仅 Electron 内可用）。

Linux 交叉打包时 NSIS 安装向导需要 wine；受限环境可改用 7z SFX 制作单文件便携版：

```bash
cd dist/win-unpacked
7z a -t7z -mx=9 ../payload.7z .
cat 7zsd_LZMA_Dialogs_x64.sfx ../../build/sfx-config.txt ../payload.7z > ../InkTask-Portable.exe
```

## 项目结构

```
InkTask/
├── main/                 # Electron 主进程
│   ├── main.js           # 窗口 / 托盘 / IPC / 图片协议
│   ├── store.js          # 原子 JSON 存储
│   └── hotkeys.js        # 全局快捷键（冲突检测）
├── preload/
│   └── preload.js        # contextBridge 白名单安全桥
├── renderer/             # 深色 UI（零框架原生 JS）
│   ├── index.html
│   ├── styles.css        # 「墨与灯」主题
│   └── js/
│       ├── app.js        # 状态管理 / 渲染 / 分组 / 日历弹层
│       ├── editor.js     # 富文本编辑 + 贴图
│       ├── urgency.js    # 紧急度评分与排序
│       ├── storage.js    # 存储适配（Electron / 浏览器）
│       └── util.js
├── tests/                # node:test 单元测试（29 项）
├── docs/
│   ├── ADR.md            # 架构决策记录
│   └── images/           # 文档截图
├── build/                # 图标资源
└── electron-builder.yml
```

## 技术架构

**Electron 主进程 + preload 白名单 IPC + 渲染层零框架原生 JS**，无任何运行时依赖。

- **为什么不用 Tauri / WPF / PWA**：Electron 离线打包最省心、原生贴图能力完整、UI 迭代最快。完整权衡见 [docs/ADR.md](./docs/ADR.md)。
- **紧急度评分**：按到期临近度与等级加权计算，临近到期自动超越高等级任务，见 `renderer/js/urgency.js`。
- **图片安全**：自定义 `inkimg://` 协议仅映射数据目录 `images/`，渲染进程无 Node 权限。

## 数据与隐私

所有数据保存在本机，无任何网络请求、无遥测：

```
%APPDATA%\墨办\
├── tasks.json      # 任务（原子写入）
├── settings.json   # 设置
└── images\         # 详情内嵌图片（UUID 命名）
```

换机迁移：设置面板 → 数据 → 导出备份，在新机器导入即可。

## FAQ

**Q：关掉窗口后程序退出了吗？**
没有，主面板隐藏到系统托盘（任务栏右下角）。托盘图标右键可真正退出。`Ctrl+Shift+Space` 随时呼出。

**Q：SmartScreen 拦截怎么办？**
应用未购买代码签名证书所致。点击「更多信息」→「仍要运行」。后续版本视情况提供签名。

**Q：数据会丢吗？**
JSON 原子写入保证断电不损坏；删除任务有 5 秒撤销窗口；另有手动导出备份兜底。

**Q：支持 macOS / Linux 吗？**
目前仅 Windows。代码层 Electron 跨平台，主要是快捷键与托盘细节需适配，欢迎 PR。

## License

[MIT](./LICENSE) © zhouxingbudai
