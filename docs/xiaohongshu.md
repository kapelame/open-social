# 连接小红书

同时发一张图到三个平台时，小红书需要给笔记填写标题，还需要一个能使用你创作中心账号的发布端。Open Social 支持连接你自行运行的第三方服务 xiaohongshu-mcp。开放平台目前把发布笔记的 `write_notes` 权限列为规划中，桥接使用你扫码登录的创作中心会话。[官方授权范围](https://openaccount.xiaohongshu.com/docs/scope) · [桥接项目](https://github.com/xpzouying/xiaohongshu-mcp)

### 1. 在本机启动服务，登录自己的账号

按桥接项目的安装说明选择与你的操作系统、CPU 相符的发行包。在同一目录运行登录工具，用小红书 App 扫码，再启动桥接服务。默认端口是 18060。启用了桥接的 `AUTH_TOKEN` 时，下一步需要填入同一个值。[上游安装与登录说明](https://github.com/xpzouying/xiaohongshu-mcp#readme)

使用 Docker 时，按上游 Compose 示例挂载会话目录以便重启后继续使用。将端口映射到本机 `127.0.0.1:18060:18060`，并把 Open Social 的图片目录只读映射到桥接容器。容器运行后可通过 `GET /api/v1/login/qrcode` 取得二维码，返回 JSON 的 `data.img` 是可在本地浏览器打开的图片 data URL。扫码后，`GET /api/v1/login/status` 返回的 `data.is_logged_in` 应为 `true`。如果启用了桥接鉴权，这两个请求均需携带 `Authorization: Bearer` 凭证。[容器配置](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/docker/docker-compose.yml) · [二维码与登录接口](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/docs/API.md)

### 2. 让 Open Social 找到桥接和图片

在工作台「渠道连接 → 小红书 → 配置渠道」中检测本机连接器或填写桥接根地址，按需填入鉴权令牌并保存。若使用环境文件，同机部署只需在 `.env` 中设置以下地址，启用鉴权时再添加 `XHS_BRIDGE_TOKEN`。

```dotenv
XHS_BRIDGE_URL=http://127.0.0.1:18060
```

如果桥接在容器里，宿主机和容器看到的图片路径可能不同。把挂载的宿主机目录设为 `XHS_LOCAL_MEDIA_DIR`，容器内的绝对目录设为 `XHS_BRIDGE_MEDIA_DIR`。例如，同一个文件在宿主机图片目录下叫 `cover.png`，容器将收到 `/app/images/cover.png`。桥接和 Open Social 必须能读取同一份图片文件。[上游图片路径处理](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/service.go)

默认图片目录是 Open Social 项目下的 `.data/media`。在桥接的 Compose 配置中增加卷映射，把下面的宿主机绝对路径替换为项目的实际路径：

```yaml
volumes:
  - /absolute/path/to/open-social/.data/media:/app/images:ro
```

在 Open Social 的 `.env` 中加入：

```dotenv
XHS_LOCAL_MEDIA_DIR=.data/media
XHS_BRIDGE_MEDIA_DIR=/app/images
```

如果设置了 `OPEN_SOCIAL_DATA_DIR`，宿主机端改用该数据目录下的 `media` 子目录。

### 3. 检查渠道，再投递图文

表单保存后可直接刷新小红书连接状态。使用环境文件时，先重启 Open Social。看到账号昵称或已连接状态后，在编辑器中选择小红书，填写标题和正文，添加至少一张图片。标题上限相当于 20 个中文字或 40 个英文字母。一次提交即可将选择的各个平台分别加入后台队列。[上游标题计数](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/pkg/xhsutil/title.go)

上游桥接在点击发布后等待创作页面跳转，再返回标题、正文、图片数和完成状态。Open Social 将这些字段与任务核对后记录提交成功。平台审核与最终公开状态可以在创作中心查看，桥接的回执中没有公开笔记链接。若出现超时、连接中断或回执不完整，先去创作中心检查该篇笔记，再决定是否重新提交，以免重复发布。[上游提交确认逻辑](https://github.com/xpzouying/xiaohongshu-mcp/blob/bb6fa2e208719ee634fec37881be29d3aa4699b3/xiaohongshu/publish.go#L459-L477) · [发布接口与回执](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/docs/API.md)
