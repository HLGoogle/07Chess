07Chess/
├── wrangler.toml         # [部署配置] Cloudflare Worker 与 Durable Object 配置
├── index.js              # [后端中枢] 支持按 ?room=xxx 动态隔离房间状态与消息广播
├── index.html            # [大厅主页] 纯容器底座，由数据配置动态驱动，无具体棋类硬编码文字
├── shared/
│   └── chat.html         # [公共组件] 独立的通用聊天页面，自适应房间号与中文昵称
└── 01Five/
    └── index.html        # [五子棋] 纯对弈逻辑（15x15盘面/选座/30秒倒计时/认输求和），右侧内嵌公共聊天
