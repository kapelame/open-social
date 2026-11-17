# 连接发布渠道

一份带图的草稿可以同时发往多个账号。首次使用时，平台需要确认谁可以代账号发布。运行 `npm start`，打开本机工作台的渠道页，选择「配置渠道」并按需填写下列参数。设置保存在本机，保存后即可授权。也可以在项目根目录的 `.env` 设置同名变量后重新启动服务。已显式提供的环境变量优先。[配置向导](setup.md)

## X

1. 在 X Developer Console 为应用启用 OAuth 2.0 用户授权和读写权限，登记回调地址 `http://127.0.0.1:4317/api/oauth/x/callback`。如果使用了其他端口，请登记实际地址并使用相同地址打开工作台。[X OAuth 设置](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
2. 在 X 的「配置渠道」填入 Client ID，机密客户端还需填入 Client Secret。保存后点击「连接账号」并授权。工作台会生成 PKCE 验证并申请 `tweet.read`、`users.read`、`tweet.write`、`media.write` 和 `offline.access`。
3. 回到渠道页，检查 X 的连接状态。发布时后台会逐张上传图片，再按草稿顺序将媒体编号附到帖子上。X 通过用户令牌发布，每条帖子最多 4 张静态图片，每张至多 5 MB，需有相应 API 额度。发出后可从发布队列打开原帖。[X 图片上传](https://docs.x.com/x-api/media/upload-media) · [X 创建帖子](https://docs.x.com/x-api/posts/create-post)

若已有具备这些权限的有效用户访问令牌，可以只设置 `X_ACCESS_TOKEN`。通过环境变量提供的令牌由你维护，到期后更新并重启服务。应用级搜索凭证与用户发布凭证分别配置。

## LinkedIn 个人账号

1. 在开发者应用的 Products 中开通 **Share on LinkedIn**。要自动识别当前登录的个人账号，再开通 **Sign In with LinkedIn using OpenID Connect**。在 LinkedIn 的「配置渠道」填入 Client ID 和 Client Secret。若已有当前授权用户的个人 URN，可设置 `LINKEDIN_AUTHOR_URN=urn:li:person:你的会员ID`，此时只申请 `w_member_social`。[个人发帖权限](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09) · [OpenID Connect 身份](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)
2. 配置应用的回调入口。标准网页授权需要 HTTPS，在 `LINKEDIN_REDIRECT_URI` 填写自己控制的完整 HTTPS 地址，设置转发方式见下一节。已获准使用原生 PKCE 的应用可设置 `LINKEDIN_NATIVE_PKCE=1` 并在系统浏览器中打开本机工作台，使用 `http://127.0.0.1:4317/api/oauth/linkedin/callback` 作为回调地址。保存后，把渠道卡显示的回调地址原样复制到 LinkedIn 应用的 Auth 配置。标准网页应用缺少 HTTPS 地址时，渠道页会提示补全设置。[网页授权](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) · [原生 PKCE](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native)
3. 重启工作台，点击渠道页的 LinkedIn 授权入口。回到本机渠道页后即可检查连接状态。单图会作为媒体发帖，多图使用 MultiImage。帖子回执中的编号可在队列中打开。平台只向符合资格的应用返回可刷新令牌，如授权到期，按渠道页提示重新连接。[图片上传](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-09) · [多图帖子](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api?view=li-lms-2026-09) · [刷新令牌](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)

已有个人用户令牌的本机安装也可以直接填写 `LINKEDIN_ACCESS_TOKEN` 和该成员的 `LINKEDIN_AUTHOR_URN`。发布适配器默认请求 API 版本 `202609`，可通过 `LINKEDIN_API_VERSION` 选择应用支持的有效版本。 [LinkedIn API 版本](https://learn.microsoft.com/en-us/linkedin/marketing/versioning?view=li-lms-2026-09)

### 将标准 HTTPS 回调转到本机

假定你的 HTTPS 入口为 `https://callback.example.org`，代理与 Open Social 在同一台机器运行，本机端口为 `4317`。在已启用 HTTPS 的专用 Nginx 虚拟主机中，加入下面的路径规则。代理将请求的 Host 改为实际监听的回环地址和端口，同时保留 LinkedIn 传回的 code 与 state。请将示例域名、端口换成自己使用的值。[Nginx 反向代理配置](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)

```nginx
location = /api/oauth/linkedin/callback {
    access_log off;
    proxy_set_header Host 127.0.0.1:4317;
    proxy_pass http://127.0.0.1:4317;
    proxy_redirect off;
}
location / {
    return 404;
}
```

将 `https://callback.example.org/api/oauth/linkedin/callback` 填入 `LINKEDIN_REDIRECT_URI` 和 LinkedIn 应用的回调地址。从本机工作台发起授权并完成平台确认，浏览器应回到最初打开的本机渠道页，显示 LinkedIn 已连接。

## 小红书

图文发布通过自己运行的开源桥接器操作已登录的小红书账号。启动桥接器后，在「配置渠道」检测本机连接器或填写桥接地址。保存后获取二维码并扫码，渠道页会读取登录状态。Docker 版还需要映射素材目录。具体命令和检查方法见[小红书桥接配置](xiaohongshu.md)。官方账号开放平台目前将 `write_notes` 标为规划中。[小红书开放平台权限](https://openaccount.xiaohongshu.com/docs/scope)

## 发布与回执

在编辑器选择渠道，为需要单独措辞的平台编辑文案，添加图片后提交。保持本机服务运行即可关闭网页。每个渠道单独保存一次结果。素材上传和明确的限流可以安全重试；如果发帖请求已送出但确认响应丢失，队列会提示先去账号主页核对，防止重复发布。小红书桥接回执代表已提交，公开状态请到创作中心查看。

OAuth 文件默认保存在 `.data/oauth/`，权限为仅当前用户可读写。断开 OAuth 渠道会删除本机令牌；如还需要撤销平台侧授权，可在对应账号的已连接应用里操作。在「配置渠道」清除固定令牌或桥接凭证即可断开对应连接。通过环境变量提供的值需要从环境中移除并重启。
