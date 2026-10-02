import ActivityKit
import UIKit
import UserNotifications

struct DeliveryAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var status: String
        var progress: Double
    }

    let orderId: String
}

enum PushTokenUploader {
    // 生产项目中请改为你的 HTTPS API，并加入用户认证。
    static let baseURL = URL(string: "http://YOUR_MAC_LAN_IP:3000")!

    static func upload(token: String, kind: String) async {
        // 此服务的发送接口直接接收 token。这里先打印，复制后即可用 README 中的 curl 联调。
        // 正式应用应另建带用户认证的注册接口，保存 token、kind 和 userId 的映射。
        print("Upload \(kind) token to \(baseURL): \(token)")
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            guard granted, error == nil else { return }
            DispatchQueue.main.async { application.registerForRemoteNotifications() }
        }
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await PushTokenUploader.upload(token: token, kind: "device") }
    }
}

@available(iOS 16.2, *)
func startDeliveryActivity() throws {
    let attributes = DeliveryAttributes(orderId: "order-123")
    let state = DeliveryAttributes.ContentState(status: "已接单", progress: 0.1)
    let activity = try Activity<DeliveryAttributes>.request(
        attributes: attributes,
        content: ActivityContent(state: state, staleDate: nil),
        pushType: .token
    )

    Task {
        for await data in activity.pushTokenUpdates {
            let token = data.map { String(format: "%02x", $0) }.joined()
            await PushTokenUploader.upload(token: token, kind: "live-activity")
        }
    }
}

@available(iOS 17.2, *)
func observePushToStartToken() {
    Task {
        for await data in Activity<DeliveryAttributes>.pushToStartTokenUpdates {
            let token = data.map { String(format: "%02x", $0) }.joined()
            await PushTokenUploader.upload(token: token, kind: "push-to-start")
        }
    }
}
