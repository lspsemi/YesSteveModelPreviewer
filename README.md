# YSM 可视化查看器

基于 Vite、Three.js 和 Lucide 的 YSM 模型预览器，提供模型信息展示、三维预览、动画控制及本地模型导入。
启动时不加载任何模型，通过右上角按钮或拖放导入模型文件夹 / ZIP 压缩包。
可作为网页运行，也可通过 Tauri 打包为 Windows 桌面应用。

## 本地运行（网页）

需要 Node.js 20.19+（20.x）或 22.12+；建议使用 Node.js 24。
在本仓库根目录执行：

```sh
npm ci
npm run dev
```

打开终端输出的本地地址。

```sh
npm run build    # 构建到 dist/
npm run preview  # 本地预览构建结果
```

## Windows 桌面应用

额外需要 Rust（MSVC 工具链）及 Microsoft C++ 生成工具。运行时依赖 WebView2，Windows 10/11 通常已自带。

```sh
npm run desktop:dev    # 以桌面窗口方式开发调试
npm run desktop:build  # 构建发行版
```

构建产物：

- `src-tauri/target/release/ysm-preview.exe`：可直接运行的单文件程序
- `src-tauri/target/release/bundle/nsis/YSM 预览器_<版本>_x64-setup.exe`：安装包（安装到当前用户，无需管理员权限）

发布新版本前，同步修改 `package.json`、`src-tauri/tauri.conf.json` 和 `src-tauri/Cargo.toml` 中的版本号。

截图水印功能在发行版中默认关闭（代码保留，开关见 `src/features.js`）。需要时以 `VITE_ENABLE_WATERMARK=true` 环境变量构建即可启用。
桌面版中外部链接会用系统浏览器打开，截图和人物卡通过系统“另存为”对话框保存。

## 目录结构

```text
.
├── src/                       # 页面、样式、渲染与动画逻辑
│   └── desktop.js              # 仅在桌面版中启用的集成（外部链接、全屏）
├── public/
│   ├── favicon.svg
│   └── fonts/
├── src-tauri/                  # Tauri 桌面壳（Rust）、图标与打包配置
├── index.html
├── vite.config.js
├── package.json
├── package-lock.json          # 提交到 Git，供 npm ci 使用
├── .gitattributes
└── .gitignore
```

`node_modules/`、`dist/`、`src-tauri/target/` 和 `.ref/` 为本地目录，不提交到 Git。
`.ref/` 存放开发参考文件。旧版查看器、Blockbench、ModernYSM 和模型测试用例保留在仓库外，不属于本项目的运行依赖。

## 上传到 GitHub

以本目录（`YSM新版查看器`）作为仓库根目录。
提交源码、`public/`、`src-tauri/`（不含 `target/`）、README、配置文件和 `package-lock.json`。

构建使用相对路径（Vite `base: './'`），可直接部署到 GitHub Pages 等子路径。
