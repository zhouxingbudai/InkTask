# 墨办 InkTask

深色系 Windows 本地离线待办软件。紧急度自动排序、剪贴板图片直接内嵌详情（非附件）、全局快捷键一键置顶/隐藏、到期倒计时。

## 功能一览

- **紧急度自动排序**：逾期 > 即将到期 > 高等级，最紧急的永远在最上面，右侧实时显示"还有多久到期"（`剩余 2小时15分` / `已逾期 3天`）。
- **剪贴板图片内嵌**：在任务详情（或快速输入框聚焦时）直接 `Ctrl+V`，图片立即以内容流形式插入详情正文，所见即所得，不是附件列表。图片本地落盘于数据目录 `images/`，通过自定义 `inkimg://` 协议安全加载。
- **全局快捷键**（任意应用中按都有效，可自定义）：
  - `Ctrl+Shift+Space`：显示 / 隐藏主窗口
  - `Ctrl+Shift+P`：窗口置顶开关
  - 窗口内 `Ctrl+F` 筛选、`Esc` 关闭面板
- **离线优先**：全部数据保存在本机（`%APPDATA%\墨办\`），无任何网络请求，JSON 原子写入防损坏。
- **其他**：托盘常驻、失焦隐藏（可选）、到期系统通知（可选）、开机自启（可选）、备份导出/导入、删除 5 秒内可撤销。

## 界面速览

- 顶部一行式快速添加：紧急度药丸（点按循环 低/中/高/急）+ 标题输入 + 到期时间
- 点击任务卡片展开详情编辑器（富文本 + 贴图）
- 底部统计 + 已完成折叠/清除

## 从源码运行

```bash
# 需要 Node.js 18+
npm install
npm start        # 开发运行
npm test         # 单元测试（排序 / 存储 / 倒计时）
```

> 无 Node 环境时也可直接用浏览器打开 `renderer/index.html` 预览 UI（数据存 localStorage，图片贴入功能仅 Electron 内可用）。

## 打包 Windows .exe

**在 Windows 机器上（可产出 NSIS 安装向导）**：

```bash
npm install
npm run dist
```

产物输出在 `dist/`：`InkTask-Setup-1.0.0.exe`（NSIS 安装包，可选安装目录、创建桌面/开始菜单快捷方式、带卸载程序）。

**在 Linux 上交叉打包（本项目已验证的产物）**：Electron 运行时与 exe 资源（图标/版本信息/asar）均为原生交叉构建，可直接产出：

```bash
npm install
npm run dist:dir   # 产出 dist/win-unpacked/ 完整可运行目录（exe 已内嵌墨滴图标）
```

NSIS 安装向导在 Linux 上需要 wine 运行 32 位安装器提取卸载程序，受限环境可能不可用。此时可改用 7z SFX 方案制作单文件便携版（本项目已附带产物 `dist/InkTask-Portable-1.0.0.exe`，108MB，双击 → 确认 → 自动解压并启动）：

```bash
cd dist/win-unpacked
7z a -t7z -m0=LZMA -mx=7 /tmp/app.7z .
cat 7zsd_LZMA_Dialogs_x64.sfx sfx-config.txt /tmp/app.7z > ../InkTask-Portable-1.0.0.exe
```

| 现成产物（`dist/`） | 说明 |
| --- | --- |
| `InkTask-Portable-1.0.0.exe` | 单文件便携版，双击自动解压运行，U 盘可带走 |
| `InkTask-win64-1.0.0.zip` | 绿色解压版，解压到任意目录后运行 `墨办.exe` |
| `win-unpacked/墨办.exe` | 免打包目录，最直接的运行形态 |

> 应用未做代码签名，首次运行 Windows SmartScreen 可能提示"未知发布者"，点击"仍要运行"即可；介意者可用便携版。

## 数据位置与安全

- 任务数据：`%APPDATA%\墨办\tasks.json`（原子写入：先写 `.tmp` 再 rename）
- 设置：`%APPDATA%\墨办\settings.json`
- 详情内嵌图片：`%APPDATA%\墨办\images\`，文件名随机 UUID，加载走 `inkimg://` 自定义协议（仅允许该目录，防路径穿越）
- 备份：设置面板 → 数据 → 导出备份（zip 包含以上全部），导入时覆盖恢复

## 技术栈

Electron（主进程 + preload 白名单 IPC + 渲染层零框架原生 JS）· 原子 JSON 存储 · 自定义 `inkimg://` 协议 · NSIS/Portable 打包。架构决策详见 `docs/ADR.md`。

## 目录结构

```
inktask/
├── main/            # Electron 主进程（窗口/托盘/快捷键/存储/图片协议）
├── preload/         # contextBridge 安全桥
├── renderer/       # 深色 UI（HTML/CSS/原生 JS）
│   └── js/          # app / editor(富文本+贴图) / urgency(排序) / storage / util
├── tests/           # node:test 单元测试
├── build/           # 图标资源
└── electron-builder.yml
```

## License

MIT
