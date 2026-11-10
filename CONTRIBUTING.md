# 贡献指南

欢迎修复问题、改进格式处理和桌面体验。提交 Issue、截图和测试样本时只使用虚构数据，请勿上传账号、密钥、个人资料库或本地 `.env`。

## 开发与验证

1. Fork 仓库并创建分支。使用 Node.js 24 在 Windows x64 上执行 `npm ci`。
2. 使用 `npm start` 开发。界面位于 `ui/`，存储与 IPC 位于 `main.cjs`，更新调度位于 `updates.cjs`。
3. 运行 `npm test` 与 `npm audit --omit=dev`。修改窗口、导入导出、加密保存或 IPC 后，执行 `npm run pack`，安装 `requirements-test.txt` 中的测试依赖并执行 `npm run test:windows`。
4. 在 Pull Request 中描述问题、修改后行为与验证结果；界面改动提供虚构资料截图。

保持 `contextIsolation`、sandbox、IPC 来源验证和 Markdown 清理；禁止让渲染进程直接读取文件、调用安装器或传入任意更新地址。测试模式仅使用独立目录，不访问个人资料库。图标操作保留可访问名称、键盘提示和焦点。

`npm start` 默认使用正式资料目录，测试资料请通过 `PROJECT_VAULT_TEST_MODE=1` 和独立的 `PROJECT_VAULT_TEST_DATA_DIR` 启动，避免把日常资料用作调试样本。

## 发布新版本（维护者）

1. 更新 `package.json`、`package-lock.json`、界面版本号和 `CHANGELOG.md`。
2. 完成测试与代码审查，合并到 `main`。确认构建中不含个人数据或有效密钥。
3. 创建并推送与版本一致的标签，例如 `git tag v0.3.0`，再执行 `git push origin v0.3.0`。
4. `Windows release` 工作流在 Windows 上打包并运行窗口测试，再将同一程序目录制作成 NSIS 安装包。
5. 检查 Release 包含 `ProjectVault-Setup-版本-x64.exe`、对应 `.exe.blockmap`、`latest.yml` 和 `SHA256SUMS.txt`，保持正式 Release，不能设为草稿或预发布。
6. 旧版本更新器从最新稳定 Release 读取元数据。发布后验证下载链接和版本描述，不覆盖已经发布的版本文件；修复应递增版本号。

首次发布可使用相同流程在本地构建、验证后上传全部产物。安装包目前未签名；如后续启用代码签名，应同时配置 CI 证书、发布者校验与文档。

## 许可

提交贡献即表示你有权按项目 MIT 许可证提供这些修改。引入依赖时保留第三方许可声明。
