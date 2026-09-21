# 07Chess 棋牌桌游平台

基于 Cloudflare Workers + Durable Objects 构建的纯边缘计算、轻量模块化棋牌游戏平台。

## 目录结构

```text
07Chess/
├── wrangler.toml         # [部署配置] Cloudflare Worker 与 Durable Object 配置
├── index.js              # [后端中枢] 支持按 ?room=xxx 动态隔离房间状态与走子仲裁
├── index.html            # [大厅主页] 纯容器底座，由注册表动态驱动，无具体棋类硬编码文字
├── shared/
│   └── chat.html         # [公共组件] 独立的通用聊天组件，自适应房间号与中文昵称
└── 01Five/
    └── gomoku.html       # [五子棋] 纯对弈逻辑 (15x15盘面/选座/30秒倒计时/认输求和)，内嵌公共聊天
```

## 模块说明

| 路径 | 角色 | 作用说明 |
| :--- | :--- | :--- |
| `index.html` | 前端大厅 | 平台容器，根据配置自动生成游戏入口卡片 |
| `01Five/gomoku.html` | 游戏单元 | 专注五子棋自身规则与 Canvas 棋盘绘制 |
| `shared/chat.html` | 共享插件 | 各游戏共用的独立聊天室，通过 iframe 挂载 |
| `index.js` | 后端服务 | 处理多房间 WebSocket、倒计时判定与消息广播 |
