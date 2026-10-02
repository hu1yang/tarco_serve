import 'dart:convert';
import 'dart:io';

/// 本地 iOS Simulator 会与 Mac 共享 localhost。
/// 真机联调时请改为 Mac 的局域网 IP，并让 Node 监听 0.0.0.0。
class PushServiceClient {
  PushServiceClient({
    this.baseUrl = 'http://127.0.0.1:3000',
    required this.bundleId,
    this.requestTimeout = const Duration(seconds: 5),
    Duration connectionTimeout = const Duration(seconds: 3),
  }) : _http = HttpClient()..connectionTimeout = connectionTimeout;

  final String baseUrl;
  final String bundleId;
  final Duration requestTimeout;
  final HttpClient _http;
  String? _key;
  String? _guestId;
  String? _guestToken;
  String? _userAccessToken;
  String? _userRefreshToken;

  String? get guestId => _guestId;
  String? get guestToken => _guestToken;
  String? get userAccessToken => _userAccessToken;
  String? get userRefreshToken => _userRefreshToken;

  Future<void> initialize({
    String? deviceId,
    String? pushToken,
    String? savedGuestToken,
    String? savedUserRefreshToken,
    String? deviceName,
  }) async {
    final payload = <String, dynamic>{
      'bundleId': bundleId,
      if (deviceId != null)
        'device': {
          'deviceId': deviceId,
          if (pushToken != null) 'pushToken': pushToken,
          if (deviceName != null) 'deviceName': deviceName,
        },
      if (deviceId != null && (savedGuestToken ?? _guestToken) != null)
        'guestToken': savedGuestToken ?? _guestToken,
      if ((savedUserRefreshToken ?? _userRefreshToken) != null)
        'userRefreshToken': savedUserRefreshToken ?? _userRefreshToken,
    };
    final result = await _post('/api/init', payload, authenticated: false);
    _key = result['key'] as String;
    final guest = result['guest'];
    if (guest is Map<String, dynamic>) {
      _guestId = guest['guestId'] as String?;
      _guestToken = guest['guestToken'] as String?;
    }
    final auth = result['auth'];
    if (auth is Map<String, dynamic>) {
      _userAccessToken = auth['accessToken'] as String?;
      _userRefreshToken = auth['refreshToken'] as String?;
    }
  }

  Future<Map<String, dynamic>> sendNotification({
    required String title,
    required String body,
    Map<String, dynamic> data = const {},
  }) {
    return _post('/api/push/notification', {
      'alert': {'title': title, 'body': body},
      'data': data,
    });
  }

  Future<Map<String, dynamic>> startLiveActivity({
    required String attributesType,
    required Map<String, dynamic> attributes,
    required Map<String, dynamic> contentState,
  }) {
    return _post('/api/live-activity/start', {
      'attributesType': attributesType,
      'attributes': attributes,
      'contentState': contentState,
    });
  }

  Future<Map<String, dynamic>> updateLiveActivity(
    Map<String, dynamic> contentState,
  ) {
    return _post('/api/live-activity/update', {'contentState': contentState});
  }

  Future<Map<String, dynamic>> endLiveActivity(
    Map<String, dynamic> contentState,
  ) {
    return _post('/api/live-activity/end', {'contentState': contentState});
  }

  /// 持续接收网页工作台发布的灵动岛状态。
  /// 网络中断后会自动重连；服务端会补发该 Bundle ID 的最新状态。
  Stream<LiveActivityStateMessage> liveActivityStates() async* {
    while (true) {
      if (_key == null) throw StateError('请先调用 initialize()');
      try {
        final request = await _http.getUrl(
          Uri.parse('$baseUrl/api/live-activity/stream'),
        );
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $_key');
        request.headers.set(HttpHeaders.acceptHeader, 'text/event-stream');
        final response = await request.close();
        if (response.statusCode == HttpStatus.unauthorized) {
          _key = null;
          throw StateError('会话 key 已过期，请重新调用 initialize()');
        }
        if (response.statusCode != HttpStatus.ok) {
          throw HttpException('状态通道连接失败: HTTP ${response.statusCode}');
        }

        String? event;
        final dataLines = <String>[];
        await for (final line
            in response
                .transform(utf8.decoder)
                .transform(const LineSplitter())) {
          if (line.startsWith('event:')) event = line.substring(6).trim();
          if (line.startsWith('data:'))
            dataLines.add(line.substring(5).trimLeft());
          if (line.isEmpty &&
              event == 'live-activity' &&
              dataLines.isNotEmpty) {
            final json =
                jsonDecode(dataLines.join('\n')) as Map<String, dynamic>;
            yield LiveActivityStateMessage.fromJson(json);
            event = null;
            dataLines.clear();
          }
        }
      } on StateError {
        rethrow;
      } catch (_) {
        // 本地服务热重启或暂时断开时，稍后重新建立 SSE 长连接。
        await Future<void>.delayed(const Duration(seconds: 2));
      }
    }
  }

  Future<Map<String, dynamic>> _post(
    String path,
    Map<String, dynamic> body, {
    bool authenticated = true,
  }) async {
    if (authenticated && _key == null) throw StateError('请先调用 initialize()');

    final request = await _http.postUrl(Uri.parse('$baseUrl$path'));
    request.headers.contentType = ContentType.json;
    if (authenticated)
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $_key');
    request.write(jsonEncode(body));
    final response = await request.close().timeout(requestTimeout);
    final text = await utf8.decoder
        .bind(response)
        .join()
        .timeout(requestTimeout);
    final json = jsonDecode(text) as Map<String, dynamic>;
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw HttpException(json['error']?.toString() ?? text);
    }
    return json;
  }
}

class LiveActivityStateMessage {
  const LiveActivityStateMessage({
    required this.id,
    required this.sequence,
    required this.event,
    required this.contentState,
    required this.publishedAt,
    this.attributesType,
    this.attributes,
  });

  factory LiveActivityStateMessage.fromJson(Map<String, dynamic> json) {
    return LiveActivityStateMessage(
      id: json['id'] as String,
      sequence: json['sequence'] as int,
      event: json['event'] as String,
      contentState: Map<String, dynamic>.from(json['contentState'] as Map),
      publishedAt: DateTime.parse(json['publishedAt'] as String),
      attributesType: json['attributesType'] as String?,
      attributes: json['attributes'] == null
          ? null
          : Map<String, dynamic>.from(json['attributes'] as Map),
    );
  }

  final String id;
  final int sequence;
  final String event;
  final Map<String, dynamic> contentState;
  final DateTime publishedAt;
  final String? attributesType;
  final Map<String, dynamic>? attributes;
}
