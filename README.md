# ToLG - 洛谷原题查找

一个 Tampermonkey 油猴脚本：在信友队 / 英行OJ 的题目页一键查找洛谷原题，附带专注模式与题面 Markdown 复制。

## 功能

- **洛谷原题查找**，按优先级依次尝试：
  1. 用题目名搜索洛谷候选，交给大模型从候选中挑选；无 Key 或模型无结果时用本地 Dice 相似度兜底
  2. 把完整题面交给模型，直接给出洛谷题号
  3. 取题面片段在洛谷做全文搜索（`content=true`）
- **多模型支持**：OpenAI Chat Completions / Anthropic Messages 两种 API 格式，默认 DeepSeek
- **专注模式**（英行OJ）：隐藏右侧栏、题面撑满整行，把「递交」「在线编程」移到题目标签栏，带进出动效
- **复制题面**：一键复制 Markdown（标题 + 题面原文 + 时间/内存限制）
- **SPA 适配**：题目切换后自动重新注入按钮

## 支持站点

| 站点 | 域名 |
| --- | --- |
| 信友队 | `xinyoudui.com`、`ac.xinyoudui.com` |
| 英行OJ / 信星社（Hydro） | `yingxing.club`、`*.yingxing.club`、`xinxingshe.cn`、`oj.xinxingshe.cn` |

## 安装

1. 浏览器安装 [Tampermonkey](https://www.tampermonkey.net/) 扩展
2. 打开 Tampermonkey 管理面板 → 新建脚本
3. 把 [`main.js`](main.js) 的全部内容粘贴进去并保存
4. 打开题目页，标签栏会出现「查找洛谷原题」按钮

## 配置模型

在题目页点击 Tampermonkey 菜单中的 **⚙️ 模型与 API 设置**，填写：

| 配置项 | 说明 |
| --- | --- |
| API 格式 | OpenAI Chat Completions 或 Anthropic Messages |
| 请求地址 | 默认 `https://api.deepseek.com` |
| 完整 URL | 勾选后不再自动拼接 `/chat/completions` 或 `/v1/messages` |
| 模型 ID | 默认 `deepseek-chat`，也可填 `gpt-4o-mini` 等 |
| API Key | 仅保存在油猴本地存储，不会写入脚本或上传 |

不配置 Key 时，脚本仍可使用洛谷标题搜索、题面全文搜索和本地相似度匹配，只是没有模型语义判断。

## 使用

- **查找洛谷原题**：点击后按上述优先级匹配，结果弹窗会标注来源（模型语义匹配 / 模型直答 / 题面全文搜索 / 本地相似度），点击条目直达洛谷。
- **专注模式**：仅英行OJ 显示。开启后隐藏侧栏，并在标签栏提供「递交」「在线编程」入口；再次点击恢复。
- **复制题面**：复制当前题目的 Markdown，英行OJ 会附上时间/内存限制。

## 目录结构

```
main.js     油猴脚本本体（单文件，无构建步骤）
README.md   本文件
LICENSE     MIT 许可证
```

本地调试用的 OJ 页面快照（`new.html`）包含个人账号信息，已通过 `.gitignore` 排除，不随仓库发布。

## 隐私说明

使用「查找洛谷原题」时，题目名称与题面内容会发送到你在设置中配置的模型服务；同时会请求洛谷公开题目接口。仓库不包含任何 API Key。请自行评估题面内容是否适合发送给第三方模型服务。

## 免责声明

本项目仅供学习交流与查找题目出处使用。请遵守各 OJ 的使用条款，请勿用于比赛作弊等违规行为。

## License

[MIT](LICENSE)
