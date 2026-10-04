# Windows 字幕定版：2026-10-04

用户完成实测并确认本版定版。基线标识为 `2026-10-04-native-subtitle-layers`，Git 标签为 `stable-2026-10-04`，应用内版本号沿用 `0.25.0`。

## 已验收功能

- 直播实时英语识别及中文翻译，采用完整 Whisper Large v3 和 CUDA；字幕按播放时间轴调度，支持同步偏移调整。
- AI 英中字幕的大小、位置、颜色调整和样式保存。
- 应用内 MPV 全屏显示与视频比例修复。
- 直播源的可选原生字幕默认关闭，允许手动开启；重连保留选择，换台重新默认关闭。
- 启用 AI 字幕后开始录制，停止录制后生成同名英中双语 SRT；字幕时间轴以保存的视频文件为准。
- 电影和剧集的两条原生文字字幕可上下叠加，各自调整大小、距底部、颜色和对齐；支持交换轨道、返回单字幕，换集保留样式。

双层原生字幕针对 Windows 应用内 native MPV，支持 SRT、ASS 等文字字幕。ASS 装饰样式转换成普通文字后使用用户设置；PGS、DVD 等图片字幕继续使用单轨播放。压入画面的文字不属于可选字幕轨道。后台 SRT 导出不跨应用重启续传。

## 验证范围

定版前完成前后端生产构建、Windows native addon 重编译、目录包资源与依赖闭包检查，并使用真实 Electron/MPV 验证。

- 直播原生字幕策略与双语 SRT 阶段：后台 11 套、158 项针对性测试通过，3 项真实 Electron E2E 通过。
- 双层原生字幕阶段：后台 5 套、63 项和 UI 3 套、14 项针对性测试通过，2 项真实 Electron E2E 通过。电影和剧集样本含两个内嵌 ASS 轨道，覆盖独立样式、明暗主题、全屏、跳转、字幕空档清空、返回单字幕和换集保留样式。
- 正式包实际渲染上下两层英文/中文，已查看 MPV 原生画面截图；过期设置不能应用到新文件，释放会话后停止绘制。
- 正式包复测完整 Large v3 CUDA 和录制：保存视频长度 30.79 秒，生成 12 条双语 SRT，所有中文翻译成功，字幕有序且不越界；后台导出与实时字幕共享一个 Whisper 子进程，回放自动加载同名 SRT。
- 验收程序独立复制后，181 个程序文件逐一比较 SHA256，全部一致；迁移目录再次运行原生字幕验证通过。定版源码与本地验收快照逐文件校验一致。

各阶段测试有重叠，以上不作为去重后的测试总数，也不代表完成所有平台的全量测试。

## 构建依赖与保存范围

仓库保存应用源码、测试、发布说明和架构文档。播放器地址、频道凭据、用户配置、录制文件、模型和本地构建输出不属于源码同步内容。

Whisper 构建使用 `tools/live-caption/whisper-source-pin.mjs` 固定的 `whisper.cpp v1.9.4`，commit 为 `927cfce34f31707e17f2bff35c349632fb9e2c3a`。`vendor/live-caption` 是下载暂存目录，已与固定版本逐文件比较，源码内容一致；通过以下命令重新准备：

```sh
node tools/live-caption/stage-whisper-source.mjs
```

CUDA worker 的独立构建入口为 `tools/live-caption/build-whisper-cuda-helper.mjs`，需要 Windows MSVC 和通过 `IPTVNATOR_CUDA_ROOT` 指定的 CUDA SDK。打包时仍须按 native runtime 契约准备匹配的 MPV、CUDA/cuBLAS 运行库和许可证。Large v3 模型由运行配置指定，不打入 Git 源码。

此标签标记用户验收的 Windows 源码基线。Windows 定版目录包保存在用户本机，应用版本号和上游正式发布流程保持原样。

实现和运行库约束见 [Embedded MPV](../architecture/embedded-mpv-native.md)，正式发布流程见 [Release pipeline](../architecture/release-pipeline.md)。
