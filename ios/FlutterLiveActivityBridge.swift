// 将此文件加入 Flutter 项目的 Runner target。
// DeliveryAttributes 需与 Widget Extension 中的定义保持一致。
import ActivityKit
import Flutter

@available(iOS 16.2, *)
final class FlutterLiveActivityBridge {
    private var activity: Activity<DeliveryAttributes>?

    static func register(with controller: FlutterViewController) {
        let bridge = FlutterLiveActivityBridge()
        let channel = FlutterMethodChannel(
            name: "tarco/live_activity",
            binaryMessenger: controller.binaryMessenger
        )
        channel.setMethodCallHandler { call, result in
            bridge.handle(call, result: result)
        }
    }

    private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        guard call.method == "applyState",
              let arguments = call.arguments as? [String: Any],
              let event = arguments["event"] as? String,
              let rawState = arguments["contentState"] as? [String: Any],
              let status = rawState["status"] as? String,
              let progress = rawState["progress"] as? NSNumber else {
            result(FlutterError(code: "BAD_STATE", message: "灵动岛状态字段无效", details: nil))
            return
        }

        let state = DeliveryAttributes.ContentState(
            status: status,
            progress: progress.doubleValue
        )

        Task { @MainActor in
            do {
                switch event {
                case "start":
                    guard let rawAttributes = arguments["attributes"] as? [String: Any],
                          let orderId = rawAttributes["orderId"] as? String else {
                        throw BridgeError.missingOrderId
                    }
                    let attributes = DeliveryAttributes(orderId: orderId)
                    self.activity = try Activity.request(
                        attributes: attributes,
                        content: ActivityContent(state: state, staleDate: nil),
                        pushType: nil
                    )
                case "update":
                    guard let current = self.activity ?? Activity<DeliveryAttributes>.activities.first else {
                        throw BridgeError.activityNotFound
                    }
                    await current.update(ActivityContent(state: state, staleDate: nil))
                    self.activity = current
                case "end":
                    guard let current = self.activity ?? Activity<DeliveryAttributes>.activities.first else {
                        throw BridgeError.activityNotFound
                    }
                    await current.end(
                        ActivityContent(state: state, staleDate: nil),
                        dismissalPolicy: .immediate
                    )
                    self.activity = nil
                default:
                    throw BridgeError.invalidEvent
                }
                result(nil)
            } catch {
                result(FlutterError(
                    code: "LIVE_ACTIVITY_ERROR",
                    message: error.localizedDescription,
                    details: nil
                ))
            }
        }
    }
}

private enum BridgeError: LocalizedError {
    case missingOrderId
    case activityNotFound
    case invalidEvent

    var errorDescription: String? {
        switch self {
        case .missingOrderId: return "start 状态缺少 attributes.orderId"
        case .activityNotFound: return "没有正在运行的 Live Activity"
        case .invalidEvent: return "不支持的 Live Activity event"
        }
    }
}
