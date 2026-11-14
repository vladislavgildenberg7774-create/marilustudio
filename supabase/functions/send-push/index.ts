// MariluStudio — отправка пуш-уведомлений о записях.
// Supabase → Edge Functions → функция "send-push". Verify JWT: выключить.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:ваш@email)
// Проверка: откройте адрес функции в браузере — покажет, всё ли настроено.
import webpush from "npm:web-push@3.6.7";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });
const pad = (n: number) => String(n).padStart(2, "0");
const TITLES: Record<string, string> = { new: "Новая запись", moved: "Запись перенесена", cancelled: "Запись отменена" };

function serviceKey(): string | undefined {
  const k = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (k) return k;
  try { // новые проекты: секретные ключи в JSON
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    return all.default || Object.values(all)[0] as string | undefined;
  } catch { return undefined; }
}

// проверка настроек без вывода самих значений
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
let ready = false;
function init() {
  if (ready) return;
  sb = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey()!);
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT")!, Deno.env.get("VAPID_PUBLIC_KEY")!, Deno.env.get("VAPID_PRIVATE_KEY")!);
  ready = true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const problems = checkEnv();
  if (req.method === "GET") return json(problems.length ? { ok: false, problems } : { ok: true, message: "send-push настроена" });
  if (problems.length) return json({ ok: false, problems }, 500);
  try { init(); } catch (e) { return json({ ok: false, problems: ["ошибка ключей: " + (e as Error).message] }, 500); }

  let p: { appointment_id?: string; kind?: string; actor?: string | null; old_member_id?: string | null };
  try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!p.appointment_id || !TITLES[p.kind || ""]) return json({ error: "bad request" }, 400);

  const { data: a } = await sb!.from("appointments").select("*").eq("id", p.appointment_id).maybeSingle();
  if (!a) return json({ sent: 0, reason: "not found" });
  if (p.kind === "new" && Date.now() - new Date(a.created_at).getTime() > 5 * 60 * 1000) return json({ sent: 0, reason: "stale" });
  if (p.kind === "cancelled" && a.status !== "cancelled") return json({ sent: 0, reason: "not cancelled" });

  const [{ data: client }, { data: members }] = await Promise.all([
    a.client_id ? sb!.from("clients").select("name").eq("id", a.client_id).maybeSingle() : Promise.resolve({ data: null }),
    sb!.from("members").select("id,user_id,role,name").eq("studio_id", a.studio_id),
  ]);
  const master = (members || []).find((m) => m.id === a.member_id);
  const targets = [...new Set((members || [])
    .filter((m) => m.user_id && m.user_id !== p.actor &&
      (m.role === "owner" || m.role === "smm" || m.id === a.member_id || m.id === p.old_member_id))
    .map((m) => m.user_id as string))];
  if (!targets.length) return json({ sent: 0, reason: "no targets" });

  const [, mo, d] = String(a.day).split("-");
  const body = `${client?.name || "Клиент"} · ${d}.${mo} ${pad(Math.floor(a.start_min / 60))}:${pad(a.start_min % 60)}${master ? " · " + master.name : ""}`;
  const payload = JSON.stringify({ title: TITLES[p.kind!], body, url: "./", tag: "appt-" + a.id });

  const { data: subs } = await sb!.from("push_subscriptions").select("*").in("user_id", targets);
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb!.from("push_subscriptions").delete().eq("id", s.id);
    }
  }));
  return json({ sent });
});
