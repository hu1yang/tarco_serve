import 'dart:async';
import 'package:flutter/services.dart';
import 'push_service_client.dart';

/// 把 Node SSE 状态转交给 iOS ActivityKit 原生桥。
class LiveActivityListener {
  LiveActivityListener(this.client);

  static const _channel = MethodChannel('tarco/live_activity');
  final PushServiceClient client;
  StreamSubscription<LiveActivityStateMessage>? _subscription;

  void start() {
    _subscription ??= client.liveActivityStates().listen((message) async {
      await _channel.invokeMethod<void>('applyState', {
        'event': message.event,
        'contentState': message.contentState,
        'attributes': message.attributes,
      });
    });
  }

  Future<void> dispose() async {
    await _subscription?.cancel();
    _subscription = null;
  }
}
