# 这个版本改了什么

基于 [lolPing](https://github.com/darrenprx/lolPing) 上游 `main`（截至 2026-10-12，即 v0.5.1 加一个提交）的个人修改版。
版本号沿用上游的 `0.5.1`，不让自己看起来比它对应的发布更新。

加了两个功能，并把自动更新钉死为关闭，避免官方发版把这两个功能覆盖掉。

## 1. 轮盘的格子数可以自己定

上游两个轮盘都写死 8 格。这里轮盘的格数就等于它数组的长度，几何、命中判定、覆盖层和设置界面全都跟着这个长度走。

- 每个轮盘编辑器上方多一行 **轮盘格子数**：信号轮盘可选 4、6、8、10（信号池一共 11 个），表情轮盘可选 4 到 24 里
  的每一个偶数（内置表情 44 个，另外最多可导入 24 张自己的图）。
- 只提供偶数：外圈那圈浅色花瓣是隔一格一个的，只有偶数格才是对称的。
- 加格子会自动填入还没上轮盘的项目，减格子从末尾去掉。**恢复默认**回到英雄联盟的 8 格。
- 图标会随格子变密而缩小（`iconSizeFor`），所以 24 格也不会互相重叠：8 格 48px，16 格 46px，24 格 31px。
- 方位名（上、右上、右……）只在 8 格时说得通，所以其它格数改用数字编号。

## 2. 好友导入的表情能在房间里传过来

上游只传自定义表情的内容哈希、从不传图，所以别人导入的图片在房间里一律显示成"?"。这个版本按上游自己的设计文档
（`docs/superpowers/specs/2026-10-06-emotes-design.md` §8.2，标着 v0.5.1 该做但一直没写的 *M2：静态图传输*）把它实现了。

- presence 现在会宣布自己能供应的哈希：轮盘上和中心里的每个自定义表情，最多 25 个。
- 缺这张图的成员会去要（`want`），图的拥有者按 750 字节一块（`chunk`）发过去。17 块就能覆盖 12,288 字节的静态图上
  限——750 是 base64 之后还能塞进一个密封包剩余空间的最大值。
- 收端的块可以乱序到达、重复会被忽略；只有在字节哈希等于房间宣布的那个 id、以 `RIFF….WEBP` 开头、不是动画、且最长
  边不超过 160px 时，才会写进缓存。之后由 `lolping://emotes/<hash>.webp` 提供，覆盖层不用改任何代码。
- 只接受"宣布了这张图的那个人"发来的块，所以没人能拿别人的 id 换一张图。
- 只传静态图，动画永不传输。好友的表情到你这里一定是静态的。
- 缓存放在 `%APPDATA%\lolPing\emote-cache`，最多 200 个文件、4MB，按最近最少使用淘汰。
- 房间区的 **显示好友的自定义表情** 开关（默认开）关掉后：不发请求、忽略块、好友的自定义表情连"?"都不显示。
- 有限速，因为公网中继每秒多过几条就开始丢事件：LAN 上每个请求者 20 块/秒；中继上只在 10 个令牌的突发里还剩至少
  5 个时才发一块，保证信号永远不排在图片后面。中继上闲置的发送者大约每 6 秒能传完一张图。
- `tools/room-peer --emote <file.webp>` 可以宣布并供应一张图，本机验证就是靠它做的。

## 3. 关闭了自动更新

`normalizeSettings` 把 `autoUpdateCheck` 钉成 false，官方发版不会替换掉这个构建、也就不会把上面两个功能带走。设置
里"检查更新"按钮手动检查仍然可用，那个开关会显示为关。想让官方更新进来，把设置文件里的 `autoUpdateCheck` 改成
`true` 即可。

## 验证情况

- `npm test`：762 个测试全过，其中 44 个是新增的（协议校验、分块传输、缓存淘汰、以及房间内的端到端往返）。
- `npm run typecheck`：无错误。
- 真机 LAN 双端跑通：`tools/room-peer` 宣布的一张 160×120 WebP，以它自己的哈希落进了 `emote-cache`，与发出去的文
  件逐字节相同。

## 已知限制

- 中继上传图时，信号照常流动，图片大约每 6 秒一张；大表情的头几秒可能在表情已经消失之后才到。
- 缓存装 200 张图，超出后淘汰最久未用的，下次用到再拉。
- 一条 presence 最多宣布 25 个哈希——这是 1200 字节包的容量决定的。轮盘要超过 24 格的话，得换取图机制，而不是调大
  这个数字。

## 自己重新打包

需要 Node 20+，以及 Visual Studio 2022 或更新版本，并安装"使用 C++ 的桌面开发"工作负载（编译原生输入辅助进程）。

```
npm ci
npm run build:helper
npx electron-vite build
npx electron-builder --win --publish never
```

中文 Windows（代码页 936）上有两点要注意：

- `npm run dist` 会在 `build:helper` 的测试目标里中断：`cl /WX` 把 `macinput.cpp` 的 C4819 警告当成了错误。此时
  `hook-helper.exe` 其实已经生成，所以改用上面那两条命令，别用 `npm run dist`。
- 改过源码后必须先 `npm run build` 再打包：`electron-builder` 打的是 `out/`，不重新编译就会把上一次的代码打进包里。

连 GitHub 慢或被干扰时，electron 二进制和 electron-builder 的 NSIS 二进制需要换镜像：

```
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
```

npm 12 会拦掉安装脚本，所以 `npm ci` 之后 `node_modules/electron/dist` 可能不存在，需要 `node
node_modules/electron/install.js` 补下。

## 许可

跟随上游的 MIT，`LICENSE` 未改动。lolPing 作者是 darrenprx，本构建是它的修改版。
