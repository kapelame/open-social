# 配置后台自动投递

如果只想搜索话题或手动发帖，可直接从工作台打开平台官网，沿用当前浏览器里的登录会话。[网页发布步骤](setup.md)

需要 Open Social 在关闭浏览器后继续发送时，才需要为后台授予发布权限。在「渠道连接」展开相应平台的「自动投递设置」，点「配置渠道」。表单保存后即可授权。也可以在项目根目录的 `.env` 设置同名变量，重启服务后生效。

## X

1. 在 X Developer Console 为应用启用 OAuth 2.0 用户授权和读写权限，登记回调地址 `http://127.0.0.1:4317/api/oauth/x/callback`。如果使用了其他端口，请登记实际地址并使用相同地址打开工作台。[X OAuth 设置](https://docs.x.com/fundamentals/authentication/oauth-2-0/authorization-code)
2. 在 X 的「配置渠道」填入 Client ID，机密客户端还需填入 Client Secret。保存后点击「授权自动投递」并完成平台确认。工作台会生成 PKCE 验证并申请 `tweet.read`、`users.read`、`tweet.write`、`media.write` 和 `offline.access`。
3. 回到渠道页，检查 X 的连接状态。发布时后台会逐张上传图片，再按草稿顺序将媒体编号附到帖子上。X 通过用户令牌发布，每条帖子最多 4 张静态图片，每张至多 5 MB，需有相应 API 额度。发出后可从发布队列打开原帖。[X 图片上传](https://docs.x.com/x-api/media/upload-media) · [X 创建帖子](https://docs.x.com/x-api/posts/create-post)

若已有具备这些权限的有效用户访问令牌，可以只设置 `X_ACCESS_TOKEN`。通过环境变量提供的令牌由你维护，到期后更新并重启服务。发布凭证用于投递帖子。需要在工作台单独查询 X API 时，可以另设搜索凭证 `X_BEARER_TOKEN`。普通搜索与刷新不会调用该接口，只有在 X 来源点击「高级 · 单次使用可能计费的 X API」并确认后，才会请求近 7 天的样本。

## LinkedIn 个人账号

1. 在开发者应用的 Products 中开通 **Share on LinkedIn**。要自动识别当前登录的个人账号，再开通 **Sign In with LinkedIn using OpenID Connect**。在 LinkedIn 的「配置渠道」填入 Client ID 和 Client Secret。若已有当前授权用户的个人 URN，可设置 `LINKEDIN_AUTHOR_URN=urn:li:person:你的会员ID`，此时只申请 `w_member_social`。[个人发帖权限](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09) · [OpenID Connect 身份](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)
2. 配置应用的回调入口。标准网页授权需要 HTTPS，在 `LINKEDIN_REDIRECT_URI` 填写自己控制的完整 HTTPS 地址，设置转发方式见下一节。已获准使用原生 PKCE 的应用可设置 `LINKEDIN_NATIVE_PKCE=1` 并在系统浏览器中打开本机工作台，使用 `http://127.0.0.1:4317/api/oauth/linkedin/callback` 作为回调地址。保存后，把渠道卡显示的回调地址原样复制到 LinkedIn 应用的 Auth 配置。标准网页应用缺少 HTTPS 地址时，渠道页会提示补全设置。[网页授权](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow) · [原生 PKCE](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native)
3. 保存表单或重启使用环境变量配置的服务，点击渠道页的「授权自动投递」。回到本机渠道页后即可检查连接状态。单图会作为媒体发帖，多图使用 MultiImage。帖子回执中的编号可在队列中打开。平台只向符合资格的应用返回可刷新令牌，如授权到期，按渠道页提示重新连接。[图片上传](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/images-api?view=li-lms-2026-09) · [多图帖子](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/multiimage-post-api?view=li-lms-2026-09) · [刷新令牌](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens)

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

图文发布通过自己运行的开源桥接器操作已登录的小红书账号。启动桥接器后，在「自动投递设置 → 配置渠道」检测本机连接器或填写桥接地址。保存后获取二维码并扫码，渠道页会读取登录状态。Docker 版还需要映射素材目录。具体命令和检查方法见[小红书桥接配置](xiaohongshu.md)。官方账号开放平台目前将 `write_notes` 标为规划中。[小红书开放平台权限](https://openaccount.xiaohongshu.com/docs/scope)

## 发布与回执

在编辑器选择渠道，逐平台检查文案和图片，选择「自动投递」后提交。保持本机服务运行即可关闭网页。每个渠道单独保存一次结果。素材上传和明确的限流可以安全重试。如果发帖请求已送出但确认响应丢失，队列会标记为「结果待核实」，请先到账号主页核对。小红书桥接回执代表已提交，公开状态请到创作中心查看。

OAuth 文件保存在当前工作区数据目录的 `oauth/` 子目录，默认是项目内的 `.data/oauth/`，仅当前用户可读写。1.0.0 曾将部分授权写入启动命令所在的目录。如果升级后某个账号显示未连接，在「渠道连接」为该工作区重新授权即可。

断开 OAuth 渠道会删除本机令牌。如需撤销平台侧授权，可在对应账号的已连接应用里操作。在「配置渠道」清除固定令牌或桥接凭证即可断开相应连接。通过环境变量提供的值需要从环境中移除并重启。
