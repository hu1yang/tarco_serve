// 将此文件放进 Widget Extension target，而不是主 App target。
import ActivityKit
import WidgetKit
import SwiftUI

struct DeliveryLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: DeliveryAttributes.self) { context in
            HStack {
                VStack(alignment: .leading) {
                    Text("订单 \(context.attributes.orderId)")
                        .font(.caption)
                    Text(context.state.status)
                        .font(.headline)
                }
                Spacer()
                ProgressView(value: context.state.progress)
                    .frame(width: 80)
            }
            .padding()
            .activityBackgroundTint(.black.opacity(0.85))
            .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.leading) {
                    Image(systemName: "shippingbox.fill")
                }
                DynamicIslandExpandedRegion(.trailing) {
                    Text("\(Int(context.state.progress * 100))%")
                }
                DynamicIslandExpandedRegion(.bottom) {
                    VStack(alignment: .leading) {
                        Text(context.state.status)
                        ProgressView(value: context.state.progress)
                    }
                }
            } compactLeading: {
                Image(systemName: "shippingbox.fill")
            } compactTrailing: {
                Text("\(Int(context.state.progress * 100))%")
            } minimal: {
                Image(systemName: "shippingbox.fill")
            }
            .widgetURL(URL(string: "myapp://order/\(context.attributes.orderId)"))
            .keylineTint(.orange)
        }
    }
}
