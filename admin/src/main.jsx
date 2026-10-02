import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import deviceIcon from "./assets/design/mobile-phone.svg";
import sendIcon from "./assets/design/paper-plane.svg";

const storageKey = "push-deck-session";
const pages = [
  ["overview", "概览", "⌂"],
  ["push", "推送消息", "↗"],
  ["live", "实时活动", "◉"],
  ["network", "网络模拟", "⌁"],
  ["devices", "设备管理", "▯"],
  ["flights", "航班库存", "✈"],
  ["city-images", "城市图片", "▧"],
];

function readSession() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey));
    return value?.key && value?.bundleId ? value : null;
  } catch {
    return null;
  }
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  const text = await response.text();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = { raw: text };
  }
  if (!response.ok) {
    const error = new Error(
      result.error || result.message || `HTTP ${response.status}`,
    );
    error.status = response.status;
    throw error;
  }
  return result;
}

function parseJson(value, label) {
  try {
    return value.trim() ? JSON.parse(value) : {};
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
}

function useToast() {
  const [toast, setToast] = useState(null);
  const notify = useCallback((message, error = false) => {
    setToast({ message, error });
    window.setTimeout(() => setToast(null), 3400);
  }, []);
  return [toast, notify];
}

function App() {
  const [page, setPage] = useState(location.hash.slice(1) || "overview");
  const [session, setSession] = useState(readSession);
  const [health, setHealth] = useState(null);
  const [toast, notify] = useToast();

  useEffect(() => {
    fetchJson("/health")
      .then(setHealth)
      .catch(() => setHealth({ ok: false }));
    const change = () => setPage(location.hash.slice(1) || "overview");
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);

  const auth = useCallback(
    async (path, options = {}) => {
      if (!session) throw new Error("请先连接应用");
      let activeSession = session;
      const renew = async () => {
        const result = await fetchJson("/api/init", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundleId: session.bundleId }),
        });
        activeSession = { ...result, bundleId: session.bundleId };
        saveSession(activeSession);
      };
      if (new Date(session.expiresAt) <= new Date()) await renew();
      const request = () =>
        fetchJson(path, {
          ...options,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${activeSession.key}`,
            ...options.headers,
          },
        });
      try {
        return await request();
      } catch (error) {
        if (error.status !== 401) throw error;
        await renew();
        return request();
      }
    },
    [session],
  );

  function saveSession(value) {
    localStorage.setItem(storageKey, JSON.stringify(value));
    setSession(value);
  }

  const props = { session, saveSession, auth, notify };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#overview">
          <span className="brand-mark">↑</span>
          <span>
            Tarco <b>Ops</b>
          </span>
        </a>
        <p className="nav-label">工作空间</p>
        <nav>
          {pages.map(([id, label, icon]) => (
            <a key={id} className={page === id ? "active" : ""} href={`#${id}`}>
              <span>{icon}</span>
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`dot ${health?.ok ? "online" : ""}`} />
          <div>
            <strong>{health?.ok ? "服务在线" : "连接中"}</strong>
            <small>{health?.transport || "Node service"}</small>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <span className="crumb">TARCO / OPERATIONS</span>
          </div>
          <div className="top-actions">
            <span className="db-pill">
              <i /> MySQL 已连接
            </span>
            <span className="avatar">TH</span>
          </div>
        </header>
        {page === "overview" && <Overview {...props} health={health} />}
        {page === "push" && <PushPage {...props} />}
        {page === "live" && <LivePage {...props} />}
        {page === "network" && <NetworkPage {...props} />}
        {page === "devices" && <DevicesPage {...props} />}
        {page === "flights" && <FlightsPage {...props} />}
        {page === "city-images" && <CityImagesPage {...props} />}
      </main>
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`}>
          {toast.message}
        </div>
      )}
    </div>
  );
}

function PageHead({ eyebrow, title, description, action }) {
  return (
    <div className="page-head">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
        <span>{description}</span>
      </div>
      {action}
    </div>
  );
}

function ConnectCard({ session, saveSession, notify }) {
  const [bundleId, setBundleId] = useState(
    session?.bundleId || "com.example.tarcoAviation",
  );
  const [busy, setBusy] = useState(false);
  async function connect(event) {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await fetchJson("/api/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bundleId }),
      });
      saveSession({ ...result, bundleId });
      notify("应用连接成功");
    } catch (error) {
      notify(error.message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card connect-strip">
      <div>
        <small>连接应用</small>
        <strong>
          {session ? `已连接 · ${session.bundleId}` : "尚未获取会话 Key"}
        </strong>
      </div>
      <form onSubmit={connect}>
        <input
          value={bundleId}
          onChange={(e) => setBundleId(e.target.value)}
          required
        />
        <button>{busy ? "连接中…" : session ? "重新连接" : "建立连接"}</button>
      </form>
    </section>
  );
}

function Overview(props) {
  const [network, setNetwork] = useState(null);
  const [flights, setFlights] = useState(null);
  useEffect(() => {
    fetchJson("/api/network-simulator")
      .then(setNetwork)
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (props.session)
      props
        .auth("/api/admin/flights")
        .then(setFlights)
        .catch(() => {});
  }, [props.session, props.auth]);
  return (
    <div className="page">
      <PageHead
        eyebrow="CONTROL CENTER"
        title="运营概览"
        description="本地推送、网络环境与航班库存的一站式状态视图。"
      />
      <ConnectCard {...props} />
      <div className="metric-grid">
        <Metric
          label="服务状态"
          value="在线"
          detail={props.health?.transport || "检查中"}
          tone="green"
        />
        <Metric
          label="未来航班"
          value={flights?.flightCount ?? "—"}
          detail={`${flights?.operatingDateCount ?? 0} 个运营日`}
        />
        <Metric
          label="可售座位"
          value={flights?.availableSeats ?? "—"}
          detail="MCT → DOH"
        />
        <Metric
          label="网络成功率"
          value={`${network?.stats?.successRate ?? 100}%`}
          detail={network?.enabled ? "弱网模拟开启" : "正常网络"}
          tone={network?.enabled ? "amber" : "green"}
        />
      </div>
      <div className="dashboard-grid">
        <section className="card span-2">
          <CardTitle title="本周班期" meta="周一 · 周三 · 周六" />
          <div className="week-row">
            {["日", "一", "二", "三", "四", "五", "六"].map((day, index) => (
              <div
                className={[1, 3, 6].includes(index) ? "flight-day" : ""}
                key={day}
              >
                <span>周{day}</span>
                <strong>{[1, 3, 6].includes(index) ? "3 班" : "—"}</strong>
              </div>
            ))}
          </div>
        </section>
        <section className="card">
          <CardTitle title="快捷入口" />
          <div className="quick-links">
            <a href="#push">
              发送一条推送 <b>→</b>
            </a>
            <a href="#network">
              配置弱网环境 <b>→</b>
            </a>
            <a href="#flights">
              查看航班库存 <b>→</b>
            </a>
          </div>
        </section>
      </div>
    </div>
  );
}

function Metric({ label, value, detail, tone }) {
  return (
    <section className="metric card">
      <div className={`metric-icon ${tone || ""}`}>●</div>
      <small>{label}</small>
      <strong>{value}</strong>
      <span>{detail}</span>
    </section>
  );
}
function CardTitle({ title, meta }) {
  return (
    <div className="card-title">
      <h2>{title}</h2>
      {meta && <span>{meta}</span>}
    </div>
  );
}

function PushPage(props) {
  const [form, setForm] = useState({
    title: "航班即将起飞",
    body: "航班 WY 669 将在 2 小时后起飞，点击查看订单详情。",
    badge: "1",
    data: '{\n  "type": "flight_booking",\n  "orderId": "order-123"\n}',
  });
  const [busy, setBusy] = useState(false);
  const change = (key) => (event) =>
    setForm({ ...form, [key]: event.target.value });
  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await props.auth("/api/push/notification", {
        method: "POST",
        body: JSON.stringify({
          alert: { title: form.title, body: form.body },
          badge: Number(form.badge),
          data: parseJson(form.data, "自定义数据"),
        }),
      });
      props.notify("通知已发送到 iOS 模拟器");
    } catch (error) {
      props.notify(error.message, true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page">
      <PageHead
        eyebrow="PUSH MESSAGE"
        title="推送消息"
        description="创建、校验并发送面向航班旅客的通知。"
      />
      <ConnectCard {...props} />
      <div className="split">
        <form className="card form-card" onSubmit={submit}>
          <CardTitle title="消息内容" />
          <label>
            通知标题
            <input
              value={form.title}
              onChange={change("title")}
              maxLength="50"
            />
          </label>
          <label>
            通知正文
            <textarea
              value={form.body}
              onChange={change("body")}
              maxLength="240"
            />
          </label>
          <div className="field-row">
            <label>
              角标
              <input
                type="number"
                min="0"
                value={form.badge}
                onChange={change("badge")}
              />
            </label>
            <label>
              优先级
              <select>
                <option>重要</option>
                <option>普通</option>
              </select>
            </label>
          </div>
          <label>
            JSON 载荷
            <textarea
              className="code"
              value={form.data}
              onChange={change("data")}
            />
          </label>
          <button className="primary">
            {busy ? "发送中…" : "发送消息 ↗"}
          </button>
        </form>
        <section className="card preview">
          <CardTitle title="预览效果" meta="iOS Simulator" />
          <div className="phone">
            <div className="phone-time">9:41</div>
            <div className="notification">
              <b>{form.title || "通知标题"}</b>
              <p>{form.body || "通知内容"}</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function LivePage(props) {
  const [platform, setPlatform] = useState("ios");
  const [androidDevices, setAndroidDevices] = useState([]);
  const [androidDeviceKey, setAndroidDeviceKey] = useState("");
  const [event, setEvent] = useState("start");
  const [orderId, setOrderId] = useState("order-123");
  const [state, setState] = useState(
    JSON.stringify({
      status: "Boarding",
      gate: "B18",
      progress: 0.65,
      estimatedDepartureAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    }, null, 2),
  );
  const [latest, setLatest] = useState(null);
  const [startedOrderId, setStartedOrderId] = useState(null);
  useEffect(() => {
    if (platform !== "android" || !props.session) return;
    props.auth("/api/admin/devices")
      .then((result) => {
        const devices = (result.data?.devices || []).filter((device) => device.platform === "android");
        setAndroidDevices(devices);
        setAndroidDeviceKey((current) => current || (devices[0] ? `${devices[0].identityType}/${devices[0].recordId}` : ""));
      })
      .catch((error) => props.notify(error.message, true));
  }, [platform, props.session, props.auth]);
  async function submit(e) {
    e.preventDefault();
    try {
      const contentState = parseJson(state, "实时状态");
      if (event !== "start" && startedOrderId && orderId !== startedOrderId) {
        throw new Error(`当前测试活动的订单 ID 是 ${startedOrderId}；请保持一致`);
      }
      if (platform === "android" && !androidDeviceKey) {
        throw new Error("请先选择已登记的 Android 模拟器设备");
      }
      const result = await props.auth(platform === "android"
        ? `/api/admin/devices/${androidDeviceKey}/live-update`
        : "/api/live-activity/state", {
        method: "POST",
        body: JSON.stringify({
          event,
          orderId,
          contentState,
          ...(event === "start"
            ? {
                attributesType: "FlightActivityAttributes",
                attributes: {
                  orderId,
                  bookingReference: orderId,
                  flightNumber: "WY 669",
                  origin: "MCT",
                  destination: "DOH",
                },
              }
            : {}),
        }),
      });
      setLatest(platform === "android"
        ? { ...result, message: { event, orderId, contentState } }
        : result);
      if (event === "start") setStartedOrderId(orderId);
      if (event === "end") setStartedOrderId(null);
      props.notify(platform === "android"
        ? `Android 实时通知已${{ started: "启动", updated: "更新", ended: "结束" }[result.result?.outcome] || "发送"}`
        : result.delivered
          ? `已写入 ${result.delivered} 个 App 连接；请在模拟器确认显示`
          : "未连接 App；状态已保存");
    } catch (error) {
      props.notify(error.message, true);
    }
  }
  return (
    <div className="page">
      <PageHead
        eyebrow="REAL-TIME ACTIVITIES"
        title="实时活动"
        description="先启动，再用相同订单 ID 更新。Android 16+ 显示系统 Live Update；iOS 模拟器使用前台状态通道。"
      />
      <ConnectCard {...props} />
      <div className="split">
        <form className="card form-card" onSubmit={submit}>
          <CardTitle title="活动更新" />
          <div className="field-row">
            <label>
              平台
              <select value={platform} onChange={(e) => { setPlatform(e.target.value); setLatest(null); setStartedOrderId(null); }}>
                <option value="ios">iOS 灵动岛</option>
                <option value="android">Android 实时通知</option>
              </select>
            </label>
            {platform === "android" && <label>
              模拟器设备
              <select value={androidDeviceKey} onChange={(e) => { setAndroidDeviceKey(e.target.value); setStartedOrderId(null); setLatest(null); }}>
                {androidDevices.length === 0 && <option value="">没有已登记的设备</option>}
                {androidDevices.map((device) => <option key={`${device.identityType}/${device.recordId}`} value={`${device.identityType}/${device.recordId}`}>
                  {device.deviceName || device.deviceId}
                </option>)}
              </select>
            </label>}
          </div>
          <div className="field-row">
            <label>
              事件
              <select value={event} onChange={(e) => setEvent(e.target.value)}>
                <option value="start">启动</option>
                <option value="update">更新</option>
                <option value="end">结束</option>
              </select>
            </label>
            <label>
              订单 ID
              <input
                value={orderId}
                onChange={(e) => setOrderId(e.target.value)}
              />
            </label>
          </div>
          <label>
            Content State
            <textarea
              className="code tall"
              value={state}
              onChange={(e) => setState(e.target.value)}
            />
          </label>
          <button className="primary">发布实时状态</button>
        </form>
        <section className="card activity-preview">
          <CardTitle title="活动状态" meta={latest ? "刚刚更新" : "等待发布"} />
          <div className="island">
            <span>✈</span>
            <div>
              <strong>{latest?.message?.orderId || orderId}</strong>
              <small>{(latest?.message?.event || event).toUpperCase()} · Gate {latest?.message?.contentState?.gate || "--"}</small>
            </div>
            <b>{typeof latest?.message?.contentState?.progress === "number" ? `${Math.round(latest.message.contentState.progress * 100)}%` : "--"}</b>
          </div>
          <pre>{latest ? JSON.stringify(latest.message.contentState, null, 2) : "发布后显示已提交的状态"}</pre>
        </section>
      </div>
    </div>
  );
}

function NetworkPage({ notify }) {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(
    () =>
      fetchJson("/api/network-simulator")
        .then(setState)
        .catch(() => {}),
    [],
  );
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [refresh]);
  async function update(payload) {
    try {
      setState(
        await fetchJson("/api/network-simulator", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );
      notify("网络配置已更新");
    } catch (e) {
      notify(e.message, true);
    }
  }
  async function probe() {
    setBusy(true);
    try {
      await fetchJson("/api/network-simulator/probe", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Request-Id": crypto.randomUUID(),
        },
        body: "{}",
      });
      notify("探针请求成功");
    } catch (e) {
      notify(e.message, true);
    } finally {
      setBusy(false);
      setTimeout(refresh, 500);
    }
  }
  if (!state) return <div className="page loading">正在读取网络配置…</div>;
  return (
    <div className="page">
      <PageHead
        eyebrow="NETWORK SIMULATOR"
        title="网络模拟"
        description="在受控网络条件下验证推送与活动更新的可靠性。"
        action={
          <label className="switch">
            <input
              type="checkbox"
              checked={state.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
            />
            <span />
            {state.enabled ? "已开启" : "已关闭"}
          </label>
        }
      />
      <div className="split network-layout">
        <section className="card">
          <CardTitle
            title="网络配置"
            meta={
              state.profiles.find((p) => p.id === state.profileId)?.name ||
              "自定义"
            }
          />
          <div className="profile-grid">
            {state.profiles.slice(0, 6).map((p) => (
              <button
                key={p.id}
                className={state.profileId === p.id ? "selected" : ""}
                onClick={() => update({ profileId: p.id, enabled: true })}
              >
                <strong>{p.name}</strong>
                <small>{p.description}</small>
              </button>
            ))}
          </div>
          <button className="primary" disabled={busy} onClick={probe}>
            {busy ? "探测中…" : "开始探测 ▶"}
          </button>
        </section>
        <section className="card">
          <CardTitle title="实时状态" />
          <div className="network-status">
            <strong>{state.stats.successRate}%</strong>
            <span>成功率</span>
          </div>
          <div className="mini-metrics">
            <div>
              <b>{state.stats.total}</b>
              <span>请求</span>
            </div>
            <div>
              <b>{state.stats.failed}</b>
              <span>失败</span>
            </div>
            <div>
              <b>{state.stats.averageDurationMs} ms</b>
              <span>平均耗时</span>
            </div>
          </div>
        </section>
      </div>
      <section className="card table-card">
        <CardTitle title="近期请求日志" meta="自动刷新" />
        <Table
          headers={["时间", "请求", "环境", "结果", "模拟延迟", "总耗时"]}
          rows={(state.logs || []).map((log) => [
            new Date(log.timestamp).toLocaleTimeString("zh-CN", {
              hour12: false,
            }),
            `${log.method} ${log.path}`,
            log.profileId,
            <Status key="s" ok={log.outcome === "success"}>
              {log.outcomeLabel}
            </Status>,
            `${log.delayMs} ms`,
            `${log.durationMs} ms`,
          ])}
        />
      </section>
    </div>
  );
}

function FlightsPage({ auth, session, notify, saveSession }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setData(await auth("/api/admin/flights"));
    } catch (e) {
      notify(e.message, true);
    } finally {
      setLoading(false);
    }
  }, [auth, session, notify]);
  useEffect(() => {
    load();
  }, [load]);
  const rows = (data?.flights || []).slice(0, 24).map((f) => [
    f.flight_numbers_json ? jsonArray(f.flight_numbers_json).join(" / ") : f.id,
    f.departure_date,
    `${time(f.departure_minutes)} – ${time(f.departure_minutes + f.duration_minutes)}`,
    `${f.origin_code} → ${f.destination_code}`,
    f.seats_left,
    `${f.base_fare} SAR`,
    <Status key="s" ok={f.status === "scheduled"}>
      {f.status === "scheduled" ? "可售" : "已取消"}
    </Status>,
  ]);
  return (
    <div className="page">
      <PageHead
        eyebrow="OPERATION / FLIGHT INVENTORY"
        title="航班库存"
        description="查询 MySQL 中的未来班期、可售座位与航线票价。"
        action={
          <button className="secondary" onClick={load}>
            {loading ? "同步中…" : "↻ 手动同步"}
          </button>
        }
      />
      {!session ? (
        <ConnectCard
          session={session}
          saveSession={saveSession}
          notify={notify}
        />
      ) : (
        <>
          <div className="metric-grid">
            <Metric
              label="数据源"
              value="MySQL"
              detail="连接正常"
              tone="green"
            />
            <Metric
              label="航班实例"
              value={data?.flightCount ?? "—"}
              detail={`${data?.operatingDateCount ?? 0} 个运营日`}
            />
            <Metric
              label="未来库存"
              value={data?.availableSeats ?? "—"}
              detail="可售座位"
            />
            <Metric
              label="固定班期"
              value="3 天/周"
              detail="周一 · 周三 · 周六"
              tone="green"
            />
          </div>
          <section className="card table-card">
            <CardTitle title="未来 60 天班次" meta={data?.route} />
            <Table
              headers={[
                "航班",
                "日期",
                "时间",
                "航线",
                "库存",
                "基础票价",
                "状态",
              ]}
              rows={rows}
            />
          </section>
        </>
      )}
    </div>
  );
}

function DevicesPage({ auth, session, notify, saveSession }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [identityType, setIdentityType] = useState("all");
  const [activity, setActivity] = useState("all");
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(false);
  const [form, setForm] = useState({
    title: "航班状态更新",
    body: "你的航班订单状态已更新，请点击查看详情。",
    badge: "1",
    data: '{\n  "type": "flight_booking",\n  "orderId": "order-123"\n}',
  });
  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      setData((await auth("/api/admin/devices")).data);
    } catch (error) {
      notify(error.message, true);
    } finally {
      setLoading(false);
    }
  }, [auth, session, notify]);
  useEffect(() => {
    load();
  }, [load]);

  const devices = useMemo(
    () =>
      (data?.devices || []).filter((device) => {
        // A merged guest row is identity history for the same installation;
        // the corresponding user row is the actual send target.
        if (device.identityType === "guest" && device.mergedIntoUserId) {
          return false;
        }
        const haystack = [
          device.deviceName,
          device.deviceId,
          device.simulatorUdid,
          device.ownerId,
          device.ownerName,
          device.ownerEmail,
          device.bundleId,
          device.maskedPushToken,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        const recent = isRecentDevice(device.lastSeenAt);
        return (
          (!query || haystack.includes(query.toLowerCase())) &&
          (identityType === "all" || device.identityType === identityType) &&
          (activity === "all" || (activity === "recent") === recent)
        );
      }),
    [data, query, identityType, activity],
  );

  async function send(event) {
    event.preventDefault();
    if (!selected) return;
    setSending(true);
    try {
      await auth(
        `/api/admin/devices/${selected.identityType}/${selected.recordId}/notification`,
        {
          method: "POST",
          body: JSON.stringify({
            alert: { title: form.title, body: form.body },
            badge: Number(form.badge),
            data: parseJson(form.data, "自定义数据"),
          }),
        },
      );
      notify(`通知已发送到 ${selected.deviceName || selected.deviceId}`);
    } catch (error) {
      notify(error.message, true);
    } finally {
      setSending(false);
    }
  }

  const change = (key) => (event) =>
    setForm({ ...form, [key]: event.target.value });
  return (
    <div className="page devices-page">
      <PageHead
        eyebrow="OPERATIONS / DEVICES"
        title="设备管理"
        description="查看已注册的 iOS 和 Android 设备，并向指定模拟器发送通知。"
        action={
          <button className="secondary" onClick={load}>
            {loading ? "同步中…" : "↻ 刷新设备"}
          </button>
        }
      />
      {!session ? (
        <ConnectCard
          session={session}
          saveSession={saveSession}
          notify={notify}
        />
      ) : (
        <>
          <section className="card device-toolbar">
            <label className="device-search">
              <span>⌕</span>
              <input
                aria-label="搜索设备"
                placeholder="搜索设备名称、Owner ID 或 Bundle ID…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </label>
            <label>
              <small>身份类型</small>
              <select
                value={identityType}
                onChange={(event) => setIdentityType(event.target.value)}
              >
                <option value="all">全部</option>
                <option value="user">用户</option>
                <option value="guest">游客</option>
              </select>
            </label>
            <label>
              <small>活跃状态</small>
              <select
                value={activity}
                onChange={(event) => setActivity(event.target.value)}
              >
                <option value="all">全部</option>
                <option value="recent">近期活跃</option>
                <option value="inactive">较久未活跃</option>
              </select>
            </label>
          </section>
          <div className={`device-layout ${selected ? "has-selection" : ""}`}>
            <section className="card device-table-card">
              <div className="device-table-scroll">
                <table className="device-table">
                  <thead>
                    <tr>
                      <th>身份</th>
                      <th>Owner ID</th>
                      <th>设备名称</th>
                      <th>Push Token</th>
                      <th>Bundle ID</th>
                      <th>最后活跃</th>
                      <th>状态</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.length ? (
                      devices.map((device) => (
                        <tr
                          key={`${device.identityType}-${device.recordId}`}
                          className={
                            selected?.recordId === device.recordId &&
                            selected?.identityType === device.identityType
                              ? "selected-row"
                              : ""
                          }
                        >
                          <td>
                            <span
                              className={`identity-badge ${device.identityType}`}
                            >
                              {device.identityType === "user"
                                ? "用户"
                                : device.mergedIntoUserId
                                  ? "游客 · 已合并"
                                  : "游客"}
                            </span>
                          </td>
                          <td>
                            <strong className="owner-id">
                              {device.ownerId}
                            </strong>
                            <small className="owner-detail">
                              {device.ownerEmail || device.ownerName}
                            </small>
                          </td>
                          <td>
                            <span className="device-name">
                              <img src={deviceIcon} alt="" />
                              {device.deviceName || "未命名设备"}
                            </span>
                            <small className="owner-detail">
                              {device.platform === "android" ? "Android · " : "iOS · "}
                              {device.deviceId}
                            </small>
                          </td>
                          <td>
                            <code className="token-mask">
                              {device.platform === "android"
                                ? "Android 模拟器"
                                : device.maskedPushToken || "模拟器免 Token"}
                            </code>
                          </td>
                          <td>{device.bundleId}</td>
                          <td>{relativeTime(device.lastSeenAt)}</td>
                          <td>
                            <Status ok={isRecentDevice(device.lastSeenAt)}>
                              {isRecentDevice(device.lastSeenAt)
                                ? "近期活跃"
                                : "未活跃"}
                            </Status>
                          </td>
                          <td>
                            <button
                              className="device-send"
                              onClick={() => setSelected(device)}
                            >
                              <img src={sendIcon} alt="" />
                              发送
                            </button>
                          </td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan="8" className="empty">
                          {loading ? "正在读取设备…" : "没有符合条件的设备"}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <footer className="device-table-footer">
                <span>共 {devices.length} 台设备</span>
                <span>
                  {data?.users || 0} 用户 · {data?.guests || 0} 游客
                  {data?.mergedGuests
                    ? `（${data.mergedGuests} 个已合并）`
                    : ""}{" · "}
                  {data?.pushReady || 0} Token 就绪
                </span>
              </footer>
            </section>
            {selected && (
              <aside className="card device-composer">
                <button
                  className="composer-close"
                  aria-label="关闭"
                  onClick={() => setSelected(null)}
                >
                  ×
                </button>
                <div className="composer-target">
                  <span>
                    <img src={deviceIcon} alt="" />
                  </span>
                  <div>
                    <strong>{selected.deviceName || "未命名 iPhone"}</strong>
                    <small>
                      {selected.ownerId} ·{" "}
                      {selected.identityType === "user"
                        ? "用户"
                        : selected.mergedIntoUserId
                          ? `游客，已合并至用户 ${selected.mergedIntoUserId}`
                          : "游客"}
                    </small>
                  </div>
                </div>
                <div className="composer-rule" />
                <h2>发送通知</h2>
                <form onSubmit={send}>
                  <label>
                    通知标题
                    <input
                      value={form.title}
                      onChange={change("title")}
                      maxLength="50"
                      required
                    />
                  </label>
                  <label>
                    消息内容
                    <textarea
                      value={form.body}
                      onChange={change("body")}
                      maxLength="200"
                      required
                    />
                    <small className="character-count">
                      {form.body.length}/200
                    </small>
                  </label>
                  <div className="field-row">
                    <label>
                      角标
                      <input
                        type="number"
                        min="0"
                        value={form.badge}
                        onChange={change("badge")}
                      />
                    </label>
                    <label>
                      发送方式
                      <input value="立即发送" disabled />
                    </label>
                  </div>
                  <label>
                    JSON 载荷
                    <textarea
                      className="code compact-data"
                      value={form.data}
                      onChange={change("data")}
                    />
                  </label>
                  <button className="composer-submit" disabled={sending}>
                    <img src={sendIcon} alt="" />
                    {sending ? "发送中…" : "发送到此设备"}
                  </button>
                </form>
              </aside>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CityImagesPage({ auth, session, notify, saveSession }) {
  const emptyForm = { arrAirport: "", cityName: "", imageSrc: "" };
  const [form, setForm] = useState(emptyForm);
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [previewError, setPreviewError] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const result = await auth("/api/admin/city-images");
      setItems(result.data.items);
    } catch (error) {
      notify(error.message, true);
    } finally {
      setLoading(false);
    }
  }, [auth, notify, session]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPreviewError(false); }, [form.imageSrc]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) => [item.arrAirport, item.cityName, item.imageSrc]
      .some((value) => value.toLowerCase().includes(query)));
  }, [items, search]);

  function change(field, value) {
    setForm((current) => ({
      ...current,
      [field]: field === "arrAirport" ? value.toUpperCase().slice(0, 3) : value,
    }));
  }

  async function save(event) {
    event.preventDefault();
    setBusy(true);
    try {
      await auth("/api/admin/city-images", {
        method: "POST",
        body: JSON.stringify(form),
      });
      notify(`${form.arrAirport} 城市图片已保存`);
      setForm(emptyForm);
      await load();
    } catch (error) {
      notify(error.message, true);
    } finally {
      setBusy(false);
    }
  }

  function edit(item) {
    setForm({
      arrAirport: item.arrAirport,
      cityName: item.cityName,
      imageSrc: item.imageSrc,
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function remove(item) {
    if (!window.confirm(`确定删除 ${item.arrAirport} · ${item.cityName} 的图片吗？`)) return;
    try {
      await auth(`/api/admin/city-images/${item.arrAirport}`, { method: "DELETE" });
      notify(`${item.arrAirport} 城市图片已删除`);
      if (form.arrAirport === item.arrAirport) setForm(emptyForm);
      await load();
    } catch (error) {
      notify(error.message, true);
    }
  }

  if (!session) {
    return (
      <div className="page city-images-page">
        <PageHead eyebrow="DESTINATIONS" title="城市图片" description="先连接应用，再维护机场对应的目的地图片。" />
        <ConnectCard session={session} saveSession={saveSession} notify={notify} />
      </div>
    );
  }

  return (
    <div className="page city-images-page">
      <PageHead
        eyebrow="DESTINATIONS"
        title="城市图片管理"
        description="按到达机场维护目的地图片，供客户端通过 arrAirport 参数读取。"
      />

      <section className="card city-image-entry">
        <form onSubmit={save}>
          <div className="city-entry-title">
            <span>新增 / 更新</span>
            <h2>录入城市图片</h2>
          </div>
          <label>
            到达机场（IATA）
            <input
              value={form.arrAirport}
              onChange={(event) => change("arrAirport", event.target.value)}
              placeholder="例如 DOH"
              pattern="[A-Za-z]{3}"
              maxLength="3"
              required
            />
          </label>
          <label>
            城市名称
            <input
              value={form.cityName}
              onChange={(event) => change("cityName", event.target.value)}
              placeholder="例如 Doha"
              maxLength="80"
              required
            />
          </label>
          <label className="city-url-field">
            图片 URL
            <input
              type="url"
              value={form.imageSrc}
              onChange={(event) => change("imageSrc", event.target.value)}
              placeholder="https://example.com/doha.jpg"
              maxLength="2048"
              required
            />
          </label>
          <div className={`city-live-preview ${form.imageSrc && !previewError ? "has-image" : ""}`}>
            {form.imageSrc && !previewError ? (
              <img src={form.imageSrc} alt={`${form.cityName || form.arrAirport} 预览`} onError={() => setPreviewError(true)} />
            ) : (
              <span>{previewError ? "图片无法加载" : "实时预览"}</span>
            )}
          </div>
          <button className="city-save" disabled={busy}>
            <span>＋</span>{busy ? "保存中…" : "保存城市图片"}
          </button>
        </form>
      </section>

      <section className="card city-image-list">
        <div className="city-image-toolbar">
          <div>
            <h2>已保存的城市图片</h2>
            <span>{items.length} 个目的地</span>
          </div>
          <label className="city-image-search">
            <span>⌕</span>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索城市、机场代码或 URL…"
            />
          </label>
        </div>
        <div className="table-wrap city-image-table-wrap">
          <table className="city-image-table">
            <thead><tr><th>城市</th><th>机场</th><th>图片</th><th>图片 URL</th><th>更新时间</th><th>操作</th></tr></thead>
            <tbody>
              {filtered.map((item) => (
                <tr key={item.arrAirport}>
                  <td><strong>{item.cityName}</strong></td>
                  <td><span className="iata-pill">{item.arrAirport}</span></td>
                  <td><img src={item.imageSrc} alt={item.cityName} /></td>
                  <td><span className="city-image-url" title={item.imageSrc}>{item.imageSrc}</span></td>
                  <td>{item.updatedAt ? new Date(item.updatedAt).toLocaleString("zh-CN") : "—"}</td>
                  <td>
                    <div className="city-row-actions">
                      <button type="button" onClick={() => edit(item)} aria-label={`编辑 ${item.cityName}`}>✎</button>
                      <button type="button" className="danger" onClick={() => remove(item)} aria-label={`删除 ${item.cityName}`}>⌫</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && filtered.length === 0 && <div className="empty">{search ? "没有匹配的城市图片" : "还没有城市图片，请先录入一张。"}</div>}
          {loading && <div className="empty">正在加载城市图片…</div>}
        </div>
      </section>
    </div>
  );
}

function isRecentDevice(value) {
  return Date.now() - new Date(value).getTime() < 24 * 60 * 60 * 1000;
}
function relativeTime(value) {
  const difference = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(difference)) return "—";
  const minutes = Math.max(0, Math.floor(difference / 60000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

function time(minutes) {
  return `${String(Math.floor((minutes % 1440) / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}
function jsonArray(value) {
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [String(value)];
  }
}
function Status({ ok, children }) {
  return (
    <span className={`status ${ok ? "ok" : "bad"}`}>
      <i />
      {children}
    </span>
  );
}
function Table({ headers, rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {headers.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j}>{cell}</td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={headers.length} className="empty">
                暂无数据
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
