// MariluStudio — точечные пуш-уведомления о записях.
// Supabase → Edge Functions → "send-push". Verify JWT: выключить.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:ваш@email)
// Проверка: откройте адрес функции в браузере — покажет, всё ли настроено.
//
// Кто что получает:
//  • мастер — только о своих записях: новая, изменена (время/услуга), отменена, удалена;
//  • передача записи от одного мастера другому: старому «Запись снята с вас», новому «Новая запись»;
//  • главный и СММ — обо всех записях студии, если включили это в «Ещё»;
//  • тот, кто сам сделал изменение, пуш не получает.
import webpush from "npm:web-push@3.6.7";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const pad = (n: number) => String(n).padStart(2, "0");

function serviceKey(): string | undefined {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try {
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return all.default || Object.values(all)[0] as string | undefined;
  } catch { return undefined; }
}
function checkEnv() {
  const pub = Deno.env.get("VAPID_PUBLIC_KEY") || "", priv = Deno.env.get("VAPID_PRIVATE_KEY") || "", subj = Deno.env.get("VAPID_SUBJECT") || "";
  const problems: string[] = [];
  if (!Deno.env.get("SUPABASE_URL")) problems.push("нет SUPABASE_URL");
  if (!serviceKey()) problems.push("нет сервисного ключа (SUPABASE_SERVICE_ROLE_KEY)");
  if (!/^[A-Za-z0-9_-]{80,90}$/.test(pub)) problems.push("VAPID_PUBLIC_KEY не задан или неверный");
  if (!/^[A-Za-z0-9_-]{42,44}$/.test(priv)) problems.push("VAPID_PRIVATE_KEY не задан или неверный");
  if (!/^(mailto:[^\s@]+@[^\s@]+\.[a-z]{2,}|https:\/\/\S+)$/i.test(subj)) problems.push("VAPID_SUBJECT должен быть вида mailto:name@mail.ru (латиницей)");
  return problems;
}

let sb: SupabaseClient | null = null;
function init() {
  if (sb) return;
  sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey()!);
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);
}

type Member = { id: string; user_id: string | null; role: string; name: string; notify_all: boolean | null };
const MASTER_TITLE: Record<string, string> = { new: "Новая запись", changed: "Запись изменена", cancelled: "Запись отменена", deleted: "Запись удалена" };
const WATCH_TITLE: Record<string, string> = { new: "Новая запись", changed: "Запись изменена", cancelled: "Запись отменена", deleted: "Запись удалена", reassigned: "Запись передана" };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const problems = checkEnv();
  if (req.method === "GET") return json(problems.length ? { ok: false, problems } : { ok: true, message: "send-push настроена" });
  if (problems.length) return json({ ok: false, problems }, 500);
  try { init(); } catch (e) { return json({ ok: false, problems: ["ошибка ключей: " + (e as Error).message] }, 500); }

  let p: { event_id?: string };
  try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!p.event_id || !/^[0-9a-f-]{36}$/i.test(p.event_id)) return json({ error: "bad request" }, 400);

  // событие берём только из базы; каждое обрабатывается один раз и только свежее
  const { data: claimed } = await sb!.from("push_events").update({ processed_at: new Date().toISOString() })
    .eq("id", p.event_id).is("processed_at", null).gte("created_at", new Date(Date.now() - 10 * 60 * 1000).toISOString())
    .select("*");
  const ev = claimed?.[0];
  if (!ev) return json({ sent: 0, reason: "not found / already sent / stale" });
  await sb!.from("push_events").delete().lt("created_at", new Date(Date.now() - 7 * 864e5).toISOString());

  const a = ev.appt as { id: string; day: string; start_min: number; client_id: string | null; service_ids: string[] | null };
  const [{ data: client }, { data: members }, { data: services }] = await Promise.all([
    a.client_id ? sb!.from("clients").select("name").eq("id", a.client_id).maybeSingle() : Promise.resolve({ data: null }),
    sb!.from("members").select("id,user_id,role,name,notify_all").eq("studio_id", ev.studio_id),
    a.service_ids?.length ? sb!.from("services").select("name").in("id", a.service_ids) : Promise.resolve({ data: [] }),
  ]);
  const ms = (members || []) as Member[];
  const byId = (id: string | null) => ms.find((m) => m.id === id);
  const mNew = byId(ev.new_member_id), mOld = byId(ev.old_member_id);

  const [, mo, d] = String(a.day).split("-");
  const svc = (services || []).map((s: { name: string }) => s.name).join(", ");
  const base = `${client?.name || "Клиент"} · ${d}.${mo} ${pad(Math.floor(a.start_min / 60))}:${pad(a.start_min % 60)}${svc ? " · " + svc : ""}`;

  // кому что отправить: сначала мастерам (их текст важнее), потом наблюдателям
  const msgs = new Map<string, { title: string; body: string }>();
  const add = (m: Member | undefined, title: string, body: string) => {
    if (m?.user_id && m.user_id !== ev.actor && !msgs.has(m.user_id)) msgs.set(m.user_id, { title, body });
  };
  if (ev.kind === "reassigned") {
    add(mOld, "Запись снята с вас", `${base}${mNew ? " · передана: " + mNew.name : ""}`);
    add(mNew, "Новая запись", base);
  } else {
    add(ev.kind === "deleted" ? mOld : (mNew || mOld), MASTER_TITLE[ev.kind], base);
  }
  const who = ev.kind === "reassigned"
    ? ` · ${mOld?.name || "—"} → ${mNew?.name || "—"}`
    : ((mNew || mOld) ? " · " + (mNew || mOld)!.name : "");
  ms.filter((m) => (m.role === "owner" || m.role === "smm") && m.notify_all !== false)
    .forEach((m) => add(m, WATCH_TITLE[ev.kind], base + who));
  if (!msgs.size) return json({ sent: 0, reason: "no targets" });

  const { data: subs } = await sb!.from("push_subscriptions").select("*").in("user_id", [...msgs.keys()]);
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    const m = msgs.get(s.user_id)!;
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify({ title: m.title, body: m.body, url: "./", tag: "appt-" + a.id }), { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb!.from("push_subscriptions").delete().eq("id", s.id);
    }
  }));
  return json({ sent, kind: ev.kind });
});
