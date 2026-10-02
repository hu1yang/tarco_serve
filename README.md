# Flutter → Node → iOS 模拟器推送

这是一个本地开发推送服务。默认通过 Mac 自带的 `xcrun simctl push` 向当前已启动的
iOS Simulator 投递消息，不经过 Apple APNs，因此不需要证书、`.p8` 或环境变量。

通信流程：

```text
Flutter 启动 → POST /api/init → 获得临时 key
Flutter 请求 → Authorization: Bearer <key> → Node 验证 key → 投递到 iOS 模拟器
```

## 城市图片接口

在管理后台打开“城市图片”，录入到达机场三字码、城市名称和图片 URL。数据会保存到 MySQL
的 `airport_city_images` 表；同一个机场代码再次保存时会更新原记录。

客户端传 `arrAirport` 查询对应城市图片（与其他业务接口一样使用 `/api/init` 返回的 Bundle
会话 Key）：

```bash
curl 'http://127.0.0.1:3000/api/city-image?arrAirport=DOH' \
  -H 'Authorization: Bearer BUNDLE_SESSION_KEY'
```

成功响应：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "arrAirport": "DOH",
    "cityName": "Doha",
    "imageSrc": "https://images.example.com/doha.jpg",
    "createdAt": "2026-09-23T08:00:00.000Z",
    "updatedAt": "2026-09-23T08:00:00.000Z"
  }
}
```

没有对应记录时返回 HTTP 404；`arrAirport` 不是三位 IATA 代码时返回 HTTP 400。图片地址仅接受
`http` 或 `https` URL。

key 只保存在 Node 内存中，24 小时过期；服务重启后 Flutter 再初始化即可。这适合本地开发，
不是生产环境的用户登录方案。普通用户注册和登录使用下方独立的账户接口。

## 用户注册与登录

用户、bcrypt 密码哈希和登录会话均保存在本机 MySQL。注册成功后会自动登录，返回 30 天有效
的访问 Token 和 90 天无操作后过期的刷新 Token。注册字段使用 camelCase：

```bash
curl -X POST http://127.0.0.1:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d '{
    "firstName": "Ali",
    "lastName": "Khan",
    "email": "ali@example.com",
    "password": "flight123"
  }'
```

登录只需要 email 和 password：

```bash
curl -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"ali@example.com","password":"flight123"}'
```

注册和登录成功响应的 `data` 中包含 `user`、`accessToken`、`refreshToken`、`tokenType`、
`expiresAt` 和 `refreshExpiresAt`。
客户端把 `accessToken` 用于账户接口：

```bash
curl http://127.0.0.1:3000/api/auth/me \
  -H 'Authorization: Bearer USER_ACCESS_TOKEN'

curl -X POST http://127.0.0.1:3000/api/auth/logout \
  -H 'Authorization: Bearer USER_ACCESS_TOKEN'
```

密码必须为 8～128 个字符。邮箱会转为小写并保持唯一；接口永远不会返回密码或密码哈希。
账户 Token 与 Flutter `/api/init` 返回的 Bundle ID key 是两套独立凭证。

### 把用户绑定到手机

每个用户都有注册响应中返回的唯一 `user.id`。登录后，App 需要把本次安装的稳定设备 ID、
Bundle ID 和 APNs Token 绑定到当前用户；模拟器没有 APNs Token 时可以省略 `pushToken`：

```bash
curl -X POST http://127.0.0.1:3000/api/auth/devices \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer USER_ACCESS_TOKEN' \
  -d '{
    "deviceId": "installation-550e8400-e29b-41d4-a716-446655440000",
    "bundleId": "com.example.myapp",
    "pushToken": "APNS_DEVICE_TOKEN",
    "deviceName": "Ali iPhone"
  }'
```

同一安装再次提交会更新 Token；如果这台手机换了登录用户，设备会自动转绑到新用户。还可以
使用 `GET /api/auth/devices` 查看当前用户的设备，或者调用
`DELETE /api/auth/devices/:deviceId` 解绑。

后台发送通知时可以传用户 ID，服务会查询 `user_devices` 并投递到这个用户的所有设备：

```bash
curl -X POST http://127.0.0.1:3000/api/push/notification \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer BUNDLE_SESSION_KEY' \
  -d '{
    "userId": "1",
    "alert": {"title":"订单成功","body":"你的航班订单已经确认"},
    "data": {"type":"flight_booking","orderId":"order-123"}
  }'
```

真实订单表应保存 `user_id`。下单成功后用订单的 `user_id` 调用通知发送逻辑，而不是依赖
前端临时传入设备 Token。

### 游客购票与登录合并

未登录用户可以在初始化 Bundle 会话时，同时创建游客身份并登记当前设备。推荐客户端只调用
这一个接口：

```bash
curl -X POST http://127.0.0.1:3000/api/init \
  -H 'Content-Type: application/json' \
  -d '{
    "bundleId": "com.example.myapp",
    "device": {
      "deviceId": "installation-550e8400-e29b-41d4-a716-446655440000",
      "pushToken": "APNS_DEVICE_TOKEN",
      "deviceName": "Guest iPhone"
    }
  }'
```

响应会同时包含原来的 `key`，以及 `guest.guestId` 和 `guest.guestToken`。App 应安全保存
`guestToken`，以后再次初始化时放回请求顶层；服务会恢复原游客身份并刷新设备 Token，不会
重复创建游客：

```json
{
  "bundleId": "com.example.myapp",
  "guestToken": "SAVED_GUEST_TOKEN",
  "device": {
    "deviceId": "installation-550e8400-e29b-41d4-a716-446655440000",
    "pushToken": "REFRESHED_APNS_TOKEN"
  }
}
```

不传 `device` 时，`/api/init` 仍保持原来的行为，方便现有管理后台和旧客户端继续使用。
`POST /api/auth/guest` 也暂时保留为兼容接口，新客户端不再需要单独调用。

项目中的 Flutter 客户端可以直接这样初始化：

```dart
await pushService.initialize(
  deviceId: installationId,
  pushToken: apnsToken,
  savedGuestToken: savedGuestToken,
  deviceName: 'iPhone',
);

// 首次初始化后持久化，下一次启动传回 savedGuestToken。
final guestId = pushService.guestId;
final guestToken = pushService.guestToken;
```

### 自动恢复登录状态

App 应把登录响应中的 `refreshToken` 存在 Keychain 等安全存储中。每次冷启动时把它和
`/api/init` 一起发送，不需要再调用一次登录接口：

```dart
await pushService.initialize(
  deviceId: installationId,
  pushToken: apnsToken,
  savedGuestToken: savedGuestToken,
  savedUserRefreshToken: savedUserRefreshToken,
);

// 访问 Token 会刷新；仍建议覆盖保存服务端返回的最新值。
final newAccessToken = pushService.userAccessToken;
final newRefreshToken = pushService.userRefreshToken;
```

服务会刷新访问 Token，并把刷新 Token 的无操作有效期重新设为 90 天。刷新 Token 本身保持
稳定，避免启动刷新时因网络中断、客户端没收到响应而意外丢失登录状态。连续 90 天没有启动或
刷新时，`/api/init` 返回 `INVALID_REFRESH_TOKEN`，这时才需要显示登录页面。

也可以单独调用 `POST /api/auth/refresh`，请求体为
`{"refreshToken":"SAVED_REFRESH_TOKEN"}`。退出登录时把 `refreshToken` 一同传给
`POST /api/auth/logout`，会同时撤销访问和刷新 Token。

游客订单保存 `guest_id`，通知时把
`guestId` 传给 `/api/push/notification`：

```json
{
  "guestId": "550e8400-e29b-41d4-a716-446655440000",
  "alert": {"title":"订单成功","body":"你的游客订单已经确认"},
  "data": {"type":"flight_booking","orderId":"order-guest-123"}
}
```

游客随后登录或注册时，在原请求中额外携带 `guestToken`：

```json
{
  "email": "ali@example.com",
  "password": "flight123",
  "guestToken": "GUEST_TOKEN"
}
```

服务会在事务中把游客设备转移给正式用户，并返回 `guestMerged: true`。旧订单即使仍保存原来的
`guest_id`，发送通知时也会自动找到合并后的用户设备，因此不会因为登录而丢失通知目标。

### 航班报价验证与预订草稿

用户选择搜索结果中的票价后，使用 Bundle 会话 Key 重新验证实时价格、航班状态和余位：

```http
POST /api/flights/offers/revalidate
Authorization: Bearer BUNDLE_KEY
Content-Type: application/json
```

```json
{
  "inventoryId": "MCT-DOH-WY669-20260914",
  "fareCode": "ECONOMY_FLEX",
  "departureDate": "2026-09-14",
  "origin": "MCT",
  "destination": "DOH",
  "passengers": { "adults": 1, "children": 0, "infants": 0 },
  "expected": { "currency": "SAR", "total": 1280 }
}
```

成功响应包含有效 15 分钟的 `quote.quoteId`。`status` 可能为 `available`、
`price_changed` 或 `schedule_changed`；余位不足、取消、售罄和请求库存不匹配返回 HTTP 409。
客户端必须使用响应价格，不应把自己提交的 `expected.total` 当作最终价格。

填写乘客资料后创建有效 30 分钟的预订草稿。登录用户使用账户访问 Token：

```http
POST /api/bookings/drafts
Authorization: Bearer USER_ACCESS_TOKEN
Content-Type: application/json
```

游客不传 Authorization，在请求体顶层传 `guestToken`。其余字段如下：

```json
{
  "quoteId": "QUOTE_ID",
  "guestToken": "游客请求时填写",
  "contact": {
    "countryCode": "CN",
    "dialCode": "+86",
    "phoneNumber": "18226753983",
    "email": "ali@example.com"
  },
  "passengers": [{
    "clientPassengerId": "passenger-1",
    "type": "adult",
    "title": "Mr",
    "firstName": "Ali",
    "lastName": "Khan",
    "dateOfBirth": "1998-08-24",
    "frequentFlyer": {
      "program": "Sindbad",
      "membershipNumber": "WY123456"
    },
    "preferences": {
      "mealRequested": false,
      "specialServicesRequested": false
    }
  }],
  "preferences": {
    "joinSindbad": false,
    "subscribeOffers": false,
    "priorityBoarding": false
  }
}
```

修改同一草稿的乘客与联系人资料：

```http
PUT /api/bookings/drafts/:draftId/passengers
```

身份传递规则与创建草稿相同。服务端按 `owner_type + owner_id` 校验草稿归属，其他用户或
游客不能修改该草稿。

## 本地开发环境

克隆项目后，安装 [Node.js 20 或更高版本](https://nodejs.org/) 和 [Docker Desktop](https://www.docker.com/products/docker-desktop/)。数据库由 Docker Compose 在开发者自己的电脑上启动，不需要连接项目作者的 MySQL，也不需要手工创建数据库或表。

```bash
git clone git@github.com:hu1yang/tarco_serve.git
cd tarco_serve
cp .env.example .env
npm install
docker compose up -d mysql
npm run db:wait
npm run dev
```

服务首次使用数据库时会自动创建所需的数据表和基础机场、航司、班期及票价数据。需要预先生成未来 12 个月的航班库存时，可在另一个终端运行：

```bash
npm run db:seed
```

服务默认监听 `http://127.0.0.1:3000`。检查服务：

```bash
curl http://127.0.0.1:3000/health
```

成功时返回 `{"ok":true,"transport":"ios-simulator"}`。管理后台地址为 `http://127.0.0.1:3000/admin/`。

停止数据库容器但保留本地数据：

```bash
docker compose down
```

如果需要删除本地开发数据库及其中的数据：

```bash
docker compose down -v
```

Compose 默认把数据库映射到本机 `3307` 端口，以避开常见的本地 MySQL `3306` 端口；如仍有冲突，可修改 `.env` 中的 `MYSQL_PORT`。推送到 iOS 模拟器还需要 macOS、Xcode 和已启动的 iOS Simulator；数据库、API 和管理后台的普通本地开发不要求 iOS 模拟器。`.env` 是每位开发者自己的本地配置，不要提交；如需连接非 Docker 的 MySQL，只需修改其中的 `MYSQL_*` 配置。

## React 管理后台

服务启动后直接打开：

```text
http://127.0.0.1:3000/admin/
```

后台整合了运营概览、Flutter 应用连接、普通通知、iOS 灵动岛与 Android 实时通知、弱网模拟、请求日志
、设备管理和 MySQL 航班库存。页面会在浏览器本地保存 Bundle ID 和临时 key。“设备管理”
会显示正式用户与游客的 iOS、Android 设备，Push Token 仅以掩码展示；点击某行“发送”
只向该设备发送通知。iOS 模拟器通过 UDID 定向；Android 模拟器通过本机 ADB 查询 App
安装 ID 后定向发送，要求 Mac 上有 Android SDK、模拟器已连接，且安装的是 debug 版 App。
旧记录或未连接的模拟器不会回退发送到其他设备。Android 真机和正式版远程推送尚未接入
FCM；iOS 真机仍需要有效的 APNs Token。

修改 React 后台后执行构建：

```bash
npm run admin:build
```

开发时可以另开终端运行 `npm run admin:dev`，访问 `http://127.0.0.1:5173`。

灵动岛状态采用 SSE 长连接实时发给 Flutter。Node 会按 Bundle ID 隔离不同应用，并保存每个
应用的最新状态；Flutter 暂时断线后重新连接，会立即收到最新一条状态。

## 弱网模拟工作台

服务启动后打开：

```text
http://127.0.0.1:3000/network.html
```

页面可以全局开关弱网模拟，并提供弱 4G、不稳定 3G、极差 2G、高抖动、间歇断网、
固定 429、异常正文和突发连续丢失等预设。也可以单独调整延迟、503、超时、断线、429 与
异常正文的概率。

弱网开启后会影响所有已鉴权的 `/api` 业务请求，但不会影响健康检查、会话初始化和弱网
控制台自身。页面内置探针和最近请求记录，测试完成后请及时关闭总开关。弱网状态保存在 Node
进程内存中，服务重启后自动恢复为关闭。

## Flutter 接入

把 [`flutter/push_service_client.dart`](flutter/push_service_client.dart) 复制进 Flutter 项目，
将 Bundle ID 改成 Flutter iOS target 的真实 Bundle Identifier：

```dart
final pushService = PushServiceClient(
  bundleId: 'com.yourcompany.yourapp',
);

Future<void> initializeApp() async {
await pushService.initialize();
}
```

在应用初始化后启动状态监听：

```dart
final liveActivityListener = LiveActivityListener(pushService);

Future<void> initializeApp() async {
  await pushService.initialize();
  liveActivityListener.start();
}
```

需要把这两个文件复制到 Flutter 项目的 `lib/`：

- [`flutter/push_service_client.dart`](flutter/push_service_client.dart)
- [`flutter/live_activity_listener.dart`](flutter/live_activity_listener.dart)

然后把 [`ios/FlutterLiveActivityBridge.swift`](ios/FlutterLiveActivityBridge.swift) 加入 Runner target，
并在 Flutter 的 `AppDelegate.swift` 完成插件注册后注册桥接：

```swift
if #available(iOS 16.2, *),
   let controller = window?.rootViewController as? FlutterViewController {
    FlutterLiveActivityBridge.register(with: controller)
}
```

初始化后发送一条普通通知：

```dart
await pushService.sendNotification(
  title: '测试通知',
  body: '这是 Node 服务发给 iOS 模拟器的消息',
  data: {'page': 'order'},
);
```

航班通知需要把订单 ID 放在自定义数据中。App 点击通知后会用这个 ID 请求订单详情，
并在航班进入起飞前 6 小时窗口时打开灵动岛：

```dart
await pushService.sendNotification(
  title: '航班即将起飞',
  body: '航班 3T 210 将在 2 小时后起飞，点击查看订单详情。',
  data: {
    'type': 'flight_booking',
    'orderId': 'order-123',
  },
);
```

`initialize()` 返回的 key 已由 `PushServiceClient` 保存在内存，后续请求会自动携带：

```http
Authorization: Bearer <key>
```

## 模拟订单详情接口

点击通知后的订单查询接口为：

```http
GET /api/orders/:orderId
Authorization: Bearer <key>
```

本地接口会返回一个已确认、约 2 小时后起飞的模拟订单，因此满足 App 当前的灵动岛展示条件。
例如：

```bash
curl http://127.0.0.1:3000/api/orders/order-123 \
  -H 'Authorization: Bearer YOUR_KEY'
```

## 航班数据库与搜索接口

航班数据保存在本机 MySQL 的 `tarco_serve` 数据库中。默认开发数据库由项目根目录的
`docker-compose.yml` 启动，连接参数通过 `.env` 配置，可参考 `.env.example`。首次查询时服务会自动建表并按请求日期范围补齐库存；也可以在启动前一次性
生成从今天起 12 个月的数据：

```bash
npm run db:seed
```

数据库包含机场、航司、固定班期、每日航班实例、票价产品以及各票价剩余座位。价格会根据旺季
和日期做稳定浮动，少量班次会模拟取消。同一路线、日期的数据会持久化，所以航班搜索与最低价
日历会得到一致结果。

当前班期仅在每周一、周三和周六运营，其余日期在最低价日历中返回 `isSegment: false`。

传入出发机场、到达机场和出发日期，可获得用于联调的航班。机场代码必须是三个大写
英文字母，日期必须使用英文月份缩写的 `dd MMM yyyy` 格式。

```bash
curl --get http://127.0.0.1:3000/api/flights/search \
  -H 'Authorization: Bearer YOUR_KEY' \
  --data-urlencode 'depAirport=MCT' \
  --data-urlencode 'arrAirport=DOH' \
  --data-urlencode 'departure=12 Sep 2026'
```

成功响应统一为：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "currency": "SAR",
    "departureDate": "2026-09-12",
    "origin": { "code": "MCT", "city": "Muscat" },
    "destination": { "code": "DOH", "city": "Doha" },
    "resultCount": 3,
    "flights": []
  }
}
```

当前种子数据覆盖 `MCT` 与 `DOH` 之间的双向航线，运营日每个方向最多 3 个方案
（Oman Air 直飞、Etihad 经 `AUH` 中转、Qatar Airways 商务舱直飞）。每个结果额外包含持久化的 `inventoryId`；`fareOptions`
中包含对应票价的 `seatsAvailable`。

最低价日历接口会返回从今天开始，到 `restrictedMonths` 指定的最后一个月份月末为止的
最低价和航班状态。`restrictedMonths` 包含当前月，取值为 1～12：

```bash
curl -X POST http://127.0.0.1:3000/api/flights/lowest-fares \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{
    "depAirport": "MCT",
    "arrAirport": "DOH",
    "departure": "04 Sep 2026",
    "restrictedMonths": 3
  }'
```

请求中的 `departure` 日期始终会返回 `isSegment: true` 和有效的 `lostPrice`；其他日期则使用
模拟的航班状态。`departure` 必须位于今天到限制月份月末的范围内。

每天的数据结构如下；没有航班时 `lostPrice` 为 `null`：

```json
{
  "lostPrice": 860,
  "isSegment": true,
  "date": "2026-09-04"
}
```

如果客户端只方便传月份范围，可以使用按月份返回最低价的接口。`restrictedMonths` 表示从
当前月开始计算的月份总数（包含当前月），取值为 1～12。可选的 `startDate` 使用
`yyyy-MM-dd` 格式；传入后从该日期当天开始返回，不再返回更早的数据。不传时仍从今天开始，
结束日期都是最后一个限制月份的月末：

```bash
curl -X POST http://127.0.0.1:3000/api/flights/lowest-fares-by-months \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{
    "depAirport": "MCT",
    "arrAirport": "DOH",
    "startDate": "2026-09-10",
    "restrictedMonths": 3
  }'
```

响应中的 `startDate` 是实际查询起始日（未传参数时为今天），`endDate` 是最大月份的最后一天，
`fares` 中会包含区间内每天的模拟价格及航班状态。若传入的 `startDate` 早于今天，则仍从今天开始；
若晚于 `endDate`，接口会返回 400。

## 不通过 Flutter，直接测试

先把 `bundleId` 改成模拟器里已经安装的 App：

```bash
curl -X POST http://127.0.0.1:3000/api/init \
  -H 'Content-Type: application/json' \
  -d '{"bundleId":"com.yourcompany.yourapp"}'
```

复制返回的 `key`：

```bash
curl -X POST http://127.0.0.1:3000/api/push/notification \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_KEY' \
  -d '{"alert":{"title":"你好","body":"模拟器推送成功"}}'
```

## 灵动岛 / Live Activity

灵动岛不是普通通知样式。Flutter iOS 工程仍需要：

1. Widget Extension；
2. `ActivityAttributes` 和 `ContentState`；
3. Live Activities capability；
4. 支持 Dynamic Island 的模拟器机型。

示例文件：

- [`ios/LiveActivityExample.swift`](ios/LiveActivityExample.swift)：ActivityKit 数据结构与 token 监听
- [`ios/DeliveryLiveActivity.swift`](ios/DeliveryLiveActivity.swift)：锁屏和灵动岛 UI

启动：

```dart
await pushService.startLiveActivity(
  attributesType: 'DeliveryAttributes',
  attributes: {'orderId': 'order-123'},
  contentState: {'status': '已接单', 'progress': 0.1},
);
```

更新：

```dart
await pushService.updateLiveActivity(
  {'status': '配送中', 'progress': 0.6},
);
```

结束：

```dart
await pushService.endLiveActivity(
  {'status': '已送达', 'progress': 1.0},
);
```

`attributesType` 和 `contentState` 的字段必须与 Swift 中的类型完全一致。

状态服务接口：

```text
GET  /api/live-activity/stream   Flutter SSE 长连接
GET  /api/live-activity/state    查询最新状态和在线监听数
POST /api/live-activity/state    发布 start / update / end 状态
```

网页工作台通过这个状态通道模拟 App 正在前台时的实时更新。在“实时活动”页面
先选择“启动”：App 会用 `attributes` 创建活动。随后用相同的 `orderId` 发布“更新”
或“结束”。App 必须已启动并保持状态通道连接；页面显示“状态已保存”表示当前没有
App 连接。

```json
{
  "event": "update",
  "orderId": "order-123",
  "contentState": {
    "status": "Boarding",
    "gate": "A12",
    "progress": 0.65
  }
}
```

结束时把 `event` 改成 `end`。Flutter 会按 `orderId` 找到已经存在的 Activity；
没有对应活动时会忽略更新和结束状态。SSE 仅用于本地模拟，真机后台更新仍应使用 APNs 和
Live Activity Push Token。

## Android 实时通知 / Live Updates

Android 16 及以上使用系统 Live Updates，在状态栏显示进度提示；较旧版本显示持续通知。
当前本地测试通过 ADB 向已登记的 debug 模拟器发送，不依赖 App 前台运行。

1. 在 Android 模拟器启动 App，确保设备出现在后台“设备管理”。
2. 打开后台“实时活动”，将平台切换为“Android 实时通知”，选择模拟器设备。
3. 依次发送“启动”“更新”“结束”，三次保持相同的订单 ID。启动使用示例航班
   `WY 669 / MCT → DOH`；更新修改 `status`、`gate` 或 `progress`，结束会撤下通知。

服务端接口为 `POST /api/admin/devices/:identityType/:recordId/live-update`，请求体示例：

```json
{
  "event": "start",
  "orderId": "order-123",
  "attributes": {"flightNumber": "WY 669", "origin": "MCT", "destination": "DOH"},
  "contentState": {"status": "Boarding", "gate": "B18", "progress": 0.2}
}
```

此 ADB 通道只在 Android debug 模拟器 App 中启用。Android 真机和正式版的远程更新
仍需接入 FCM，系统是否将通知提升为状态栏 Live Update 也受系统版本与用户设置影响。

## 真机模式

真机在 App 被挂起或杀掉时，Node 无法直接连接手机，必须通过 Apple APNs。项目仍保留了
APNs 实现；只有切换到真机模式时才需要 `.env` 中的 Apple Team ID、Key ID 和 `.p8`。
本地模拟器开发不需要理解或填写这些配置。
