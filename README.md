# VPS Value

按自然日折算 VPS 剩余价值，支持人民币换算及高清分享图片。

- [在线使用](https://calc.shuijiao.de)
- [版本发布](https://github.com/shui1iao/vps-value/releases)

## 快速开始

需要 Node.js **20.9.0 或更高版本**（建议 Node.js 24）、npm，以及系统中可用的中文字体。

```bash
git clone https://github.com/shui1iao/vps-value.git
cd vps-value
npm ci
npm test
npm run build
npm start
```

打开 `http://127.0.0.1:4173`，健康检查地址为 `/health`。Linux 如果导出图片缺少中文，可安装系统字体，例如 Debian / Ubuntu 的 `fonts-noto-cjk`。

## 自部署

程序默认仅监听 `127.0.0.1:4173`。生产环境建议使用非 root 用户运行，并通过 Caddy / Nginx 提供 HTTPS；不要直接暴露到公网后依赖未校验的转发头生成链接。

可复制 `.env.example` 为 `.env`，设置 `PUBLIC_BASE_URL` 为你的 HTTPS 地址，再运行：

```bash
node --env-file=.env server.mjs
```

`npm start` 不自动读取 `.env`。支持的环境变量：

- `HOST` / `PORT`：监听地址和端口。
- `PUBLIC_BASE_URL`：生成分享链接使用的公开站点地址，生产环境应显式设置。
- `STATIC_DIR`：前端构建目录，默认 `dist`。
- `STORAGE_DIR`：分享图片与汇率缓存目录，默认 `storage/shares`，相对路径基于项目根目录。

运行用户需要对存储目录具有写权限。升级时保留存储目录，否则历史图片直链会失效。`.env`、运行数据、依赖及构建产物均不提交到仓库。项目没有 npm 包发布步骤。

分享图片直链公开可访问，不要把密码或其他敏感信息填入名称。日常计算在浏览器内进行；生成图片时会向本站服务端提交当前参数。参考汇率并非交易结算报价。


## 按日计费

- 仅填写 VPS 名称、实付金额与币种、到期日、账单周期。
- 名称输入默认填入 `VPS`，空名也回退为 `VPS`，自定义名称保留。默认年付，金额默认留空；桌面与手机的到期日首次均使用浏览器本地今天（`localToday()`，不是 UTC 日期），与只读交易日期一致。金额未填时禁用导出；用户清空到期日后仍提示选择到期日并禁用导出。到期日只在首次初始化时默认填入，用户修改、清空或输入的非法日期草稿不会被控件切换、午夜、窗口焦点或标签页可见性刷新覆盖。
- 交易日期自动使用浏览器本地今天，在网页和 PNG 中只读展示；内部字段仍为 `valuedAt`。跨午夜、标签页重新可见或窗口获得焦点时刷新，每次导出也重新检查日期。
- 到期当天按 0 天计算；到期后为 0；距离到期超过完整账单周期时封顶为实付金额。
- 输入金额和 16 种原币保持不变，内部结果的剩余价值、原价与日均成本仍统一真实折算 CNY 人民币；网页和 PNG 只展示剩余金额，两位小数。所有时长只显示整数天。

```text
剩余天数 = clamp(到期日 − 交易日期, 0, 账单周期天数)
剩余价值 = 实付金额 × 剩余天数 ÷ 账单周期天数
```

账单周期天数不是固定的 30 / 365：以到期日减去对应日历月数，在目标月缺少该日时取月末，再计算实际自然日差。例如月付到期 `2026-03-31`，内部倒推至 `2026-02-28`，该周期为 31 天；年付到期 `2025-02-28`，周期为 366 天。倒推日期只用于内部计算，不是输入、结果字段或导出字段。

日期解析要求严格的 `YYYY-MM-DD`，有效年份为 `0001`–`9999`。拒绝时间戳、时分秒、时区后缀、不存在的日期和非字符串；不会把 `2026-02-30` 规范化为三月。纯 UTC 整数日序号用于相减，夏令时和服务器时区不影响结果。只有“今天”的取得使用浏览器本地日历。

## 所有设备统一的自定义控件

无前端框架或新增依赖。`public/control-adapter.mjs` 的 `createCustomControls` 在手机、平板、桌面和窄鼠标窗口均初始化同一套自定义控件，不按指针能力、宽度或 UA 分流。币种 / 周期是按钮列表，到期日始终是文本框加独立日历按钮；不创建系统 select/date，不提供模式切换或隐藏代理。触屏主输入设备仅通过 CSS 保留 16px 表单文字以避免 iOS 聚焦缩放，收起字段高度仍为 44px；不改变展开面板的现有视觉。

所有设备复用 `public/controls.mjs`：币种、账单周期采用 Zeno admin 风格 listbox；到期日为可编辑的 `YYYY-MM-DD` 文本框，旁边独立日历按钮展开同风格日历，支持独立月份 / 年份面板。打字不打开日历，Alt + ↓ 打开，Enter 不提交表单；日历每次读取最新输入，只有明确选择才回填日期、重新计算。弹层挂载 `document.body`，可用时进入浏览器 Popover top layer，旧浏览器使用固定定位 portal；`hideNativePopover` 是该 Top Layer API 的关闭辅助函数，并非系统表单分支，继续保留。币种菜单采用两列、16px 圆角、右对齐；所有弹层使用不透明主题底色，按可视视口限制位置与尺寸，超高可滚动。

到期日沿用现有自定义控件的左对齐文本布局，仅维护一个活跃 `#end-at`。不替换字段、不订阅设备能力变化；用户手输、清空、部分或非法日期草稿原样保留，统一交给表单校验。手机软键盘和物理 iOS 的实际排版仍需真机验收，Chromium 触屏模拟不等于 iOS 验收。

桌面两张外部 `.panel` 使用等宽网格、同一行自然拉伸至等高，顶部 / 底部对齐；不固定高度、不拉伸内部内容。800px 及以下单列各自自然高度。

网页结果主区域展示名称、人民币剩余金额、到期日、剩余天数、真实剩余比例细进度条与交易日期，不再嵌套结果卡片边框。长名称单行省略，完整名称保留在输入、模型和标题提示中。不显示“自动使用本地今天”提示，也没有“计算详情”或原价、日均成本、已用天数、账单周期的结果展示；交易日期之后仅直接展示 FX 说明，完整保留汇率日期、来源、缓存状态及失败重试。内部计算和 API 的完整结果字段不变。

同一 `fields` 对象始终读取稳定的 HTML 字段，不产生重复 ID 或隐藏的可聚焦副本；初始化不触发分享缓存修订，选择后的回调继续共用计算与导出逻辑。清空日期会显示校验、禁用导出；打开日历不会把今天当成已选值。控制器提供幂等销毁，移除弹层与监听但不修改输入值。

- 同时只展开一个控件；Escape / 外部点击关闭，选择后列表焦点返回触发按钮，日历焦点返回到期日输入框。
- 列表支持 ↑ ↓ Home End，Enter / Space 选择；Tab 离开列表返回正常表单顺序。
- 日历支持四方向键、Home / End（周首 / 周末）、PageUp / PageDown（上 / 下月）、Shift + PageUp / PageDown（上 / 下年）。Enter / Space 选择。
- 月 / 年面板支持方向键、Home / End、翻页和 Tab；点年份后可直接选月份。今天按钮立即选择本地今天。

浏览器测试选择器：

| 用途 | 选择器 |
| --- | --- |
| 币种 / 账单周期 / 到期日输入 | `#currency` / `#billing-cycle` / `#end-at` |
| 所有设备的独立日历按钮 | `#end-at-picker` |
| 弹层 | `#currency-popover` / `#billing-cycle-popover` / `#end-at-popover` |
| 所有弹层 / 选项 | `.control-popover` / `.control-option` |
| 选币种 / 周期 | `[data-value="USD"]` / `[data-value="annual"]` 等 |
| 自定义周期 | `[data-value="custom"]`，随后填写 `#custom-days` |
| 上一页 / 下一页 | `#end-at-popover [data-action="previous"]` / `[data-action="next"]` |
| 年份 / 月份面板按钮 | `[data-action="choose-year"]` / `[data-action="choose-month"]` |
| 年 / 月选项 | `[data-year="2028"]` / `[data-month="2"]` |
| 日期选项 | `[data-date="2028-02-29"]` |
| 今天 | `[data-action="today"]` |
| 交易日期 / 直接汇率说明 | `#valued-label` / `#fx-description` |

三组活跃控件的 ID 不变。所有设备的币种 / 周期均为按钮，其 `.value` 为当前值；到期日为 `input#end-at[type="text"]`，通过 `#end-at-picker` 打开日历。`html[data-control-mode="custom"]` 是固定验收标识，不存在运行时切换。应点击自定义按钮及其 `[role="option"]` 而非使用 `selectOption`。日期为空或非法时，即使金额未填也显示错误、设置 `aria-invalid` 并禁用导出；打开日历只提供浏览起点，不自动修正草稿或选中今天。

## 常见币种

按顺序支持 16 种：CNY 人民币、USD 美元、EUR 欧元、GBP 英镑、HKD 港币、JPY 日元、SGD 新加坡元、TWD 新台币、AUD 澳元、CAD 加元、KRW 韩元、INR 印度卢比、CHF 瑞士法郎、RUB 俄罗斯卢布、MYR 马来西亚林吉特、THB 泰铢。

`src/core.mjs` 的 `CURRENCY_NAMES` / `CURRENCIES` 统一维护名称与允许列表；所有设备的菜单均显示代码和完整中文名。菜单上下两行呈现，长中文可换行、不省略；收起按钮仍为 108px 紧凑代码。日算法不变，浏览器和分享模型共用 `convertResultToCny` 转换三个金额字段，转换中途不提前舍入；网页与 PNG 只展示人民币剩余金额，用 `formatMoney(..., 'CNY')` 显示两位小数（JPY / KRW 输入也一样）。完整金额字段继续保留在内部结果与 API。

## 参考汇率：GET /api/exchange-rates

返回 `{ok:true,snapshot:{id,date,rates,source},stale}`，其中 `rates` 为 16 种货币每 1 单位兑人民币，`CNY:1`。数据源为日更、CC0-1.0 的 [fawazahmed0/exchange-api](https://github.com/fawazahmed0/exchange-api)。服务端取 jsDelivr / Cloudflare Pages 的 CNY 基准数据，再取倒数；主镜像日期早于 UTC 今天时比较备镜像并选更新日期。不硬编码汇率，不向客户端开放任意上游。

服务端校验完整币种、有限正数、CNY=1、真实日期与不超过 7 天的年龄；每个镜像 8 秒超时，同进程请求合并，1 小时刷新，失败后 1 分钟退避。最多保存 8 个日期/内容摘要快照，通过原子替换持久化到 `storageDir/.fx-cache.json`（点文件不经图片路由公开）。重启可继续使用有效缓存，失败且无可信缓存返回 503，有缓存时明确标 `stale` 与汇率日期，不冒充当天。CNY 输入完全不依赖汇率请求。

浏览器只访问同源 API，保持原 CSP。加载/失败时清空外币结果并禁用导出，提供“重试汇率”；切币种期间完成的请求只更新汇率快照，按当前输入重绘。网页保留完整参考汇率、日期、来源与缓存状态信息；PNG 不再展示汇率说明，但继续绑定同一可信快照计算人民币剩余金额。换快照或改变输入均使旧导出修订失效。

## API：POST /api/shares

`Content-Type: application/json`，请求示例：

```json
{
  "name": "Tokyo Premium",
  "amount": 120,
  "currency": "CNY",
  "endAt": "2027-09-05",
  "valuedAt": "2026-09-05",
  "billingCycle": "annual"
}
```

| 字段 | 契约 |
| --- | --- |
| `name` | 可省略的字符串；压缩连续空白，最多 80 Unicode 字符，省略或空值回退为 `VPS` |
| `amount` | 必填 JSON number，有限且 `0 < amount <= 1000000000`；拒绝字符串、布尔值等隐式转换 |
| `currency` | 必填字符串，支持 CNY / USD / EUR / GBP / HKD / JPY / SGD / TWD / AUD / CAD / KRW / INR / CHF / RUB / MYR / THB，去除首尾空白并转大写 |
| `endAt` | 必填严格日期字符串，到期日 |
| `valuedAt` | 交易日期的内部字段，必填严格日期字符串，客户端发送本地今天；服务器不以自己的时区改写 |
| `billingCycle` | 必填：`monthly`（1 月）、`quarterly`（3 月）、`semiannual`（6 月）、`annual`（12 月）、`biennial`（24 月）、`triennial`（36 月）、`custom` |
| `customDays` | 仅 `custom` 时必填，JSON 整数 `1..36500`；其他周期忽略且不进入规范模型 |
| `fxSnapshotId` | 外币必填，来自同源 GET 的 `snapshot.id`；CNY 不需要 |

服务端用同一个 `src/core.mjs` 重新计算，忽略伪造的结果、汇率和汇率日期字段。外币快照缺少 / 未知 / 过期返回 409 提示刷新重试，绝不偷偷替换为另一汇率。缺少账单周期、日期 / 金额 / 周期非法返回 400（外币先校验快照）。旧版缺少周期的请求不再被接受。

201 响应为 `{ ok, id, imageUrl, markdown, result, fx }`。`result.currency` 固定 `CNY`，`amount`、`remainingValue`、`dailyCost` 均为人民币；其余 `totalDays`、`elapsedDays`、`remainingDays`、`usedRatio`、`remainingRatio` 不变。`fx` 为 `{sourceCurrency,rate,snapshotId,date,source,stale}`；CNY 的 `rate=1`、快照/日期/来源为 null。天数字段都是整数，不暴露日期倒推过程。

SVG 保持 1200×630 逻辑画布；Sharp 在读取矢量输入时使用 `density: 216`（默认 72 DPI 的 3 倍），原生生成 **3600×1890 不透明无损 PNG**，不是把低分辨率位图 resize 放大。图片仅保留 **VPS 名称、人民币剩余金额、到期日、剩余天数、底部小字交易日期** 五项，共 8 个文本节点；全画布使用 `#edf3ff → #f1f6fb → #edf7f9` 淡色渐变，搭配少量淡蓝 / 青色大圆弧、淡紫色块与几何线条纹理，不留纯白主区域。文字附近仍保持浅色高对比，正文深色、主金额蓝色。单条细进度条使用服务端结果的真实 `remainingRatio`，支持零、部分和全满，不设置虚假的最小填充；不添加品牌、图标、徽章、图片、滤镜、阴影或额外说明。名称最多显示 26 个 Unicode 字符（含省略号），长金额按 1000px 宽度预算缩小。图片由服务端生成、XML 转义名称；API 完整结果、网页直接展示的 FX 信息、已有 `/shares/*.png` 文件及分享 URL / Markdown 文本契约保持不变。新导出不含时分秒。

客户端按输入修订号隔离分享缓存；编辑（包括改回原值）使正在生成的旧结果作废，避免错误链接或错名下载。同一修订并发导出合并请求，下载文件名取生成时的不可变输入快照；下载完成前再次校验修订号。

## 开发与验证

```bash
npm test
npm run build
npm audit --omit=dev
PORT=4174 PUBLIC_BASE_URL=http://127.0.0.1:4174 npm start
```

依赖按 lockfile 安装。构建产物位于 `dist/`，公开图片保存于 `storage/shares/`。构建把 HTML、全部客户端模块与 CSS 的内容摘要作为 `/assets/<版本>/` 路径，模块只做同版本的相对导入，避免新旧核心混载。构建先生成临时目录，成功后替换本树的 `dist`；拒绝替换 `dist` 符号链接。构建不是部署。

健康检查为 `/health`。服务保留请求大小 / 生成频率限制、安全响应头和只读图片路由。反向代理后的客户端共用服务端生成频率限制；个人用途建议保持现有限制。
