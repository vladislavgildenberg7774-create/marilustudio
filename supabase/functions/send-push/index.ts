// MariluStudio — отправка пуш-уведомлений о записях.
// Supabase → Edge Functions → функция "send-push". Verify JWT: выключить.
// Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:ваш@email)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:admin@marilustudio.app",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const pad = (n: number) => String(n).padStart(2, "0");
const TITLES: Record<string, string> = { new: "Новая запись", moved: "Запись перенесена", cancelled: "Запись отменена" };

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  let p: { appointment_id?: string; kind?: string; actor?: string | null; old_member_id?: string | null };
  try { p = await req.json(); } catch { return new Response("bad json", { status: 400 }); }
  if (!p.appointment_id || !TITLES[p.kind || ""]) return new Response("bad request", { status: 400 });

  const { data: a } = await sb.from("appointments").select("*").eq("id", p.appointment_id).maybeSingle();
  if (!a) return Response.json({ sent: 0, reason: "not found" });
  // защита от повторной рассылки по старым записям
  if (p.kind === "new" && Date.now() - new Date(a.created_at).getTime() > 5 * 60 * 1000) return Response.json({ sent: 0, reason: "stale" });
  if (p.kind === "cancelled" && a.status !== "cancelled") return Response.json({ sent: 0, reason: "not cancelled" });

  const [{ data: client }, { data: members }] = await Promise.all([
    a.client_id ? sb.from("clients").select("name").eq("id", a.client_id).maybeSingle() : Promise.resolve({ data: null }),
    sb.from("members").select("id,user_id,role,name").eq("studio_id", a.studio_id),
  ]);
  const master = (members || []).find((m) => m.id === a.member_id);
  const targets = [...new Set((members || [])
    .filter((m) => m.user_id && m.user_id !== p.actor &&
      (m.role === "owner" || m.role === "smm" || m.id === a.member_id || m.id === p.old_member_id))
    .map((m) => m.user_id as string))];
  if (!targets.length) return Response.json({ sent: 0, reason: "no targets" });

  const [y, mo, d] = String(a.day).split("-");
  const body = `${client?.name || "Клиент"} · ${d}.${mo} ${pad(Math.floor(a.start_min / 60))}:${pad(a.start_min % 60)}${master ? " · " + master.name : ""}`;
  const payload = JSON.stringify({ title: TITLES[p.kind!], body, url: "./", tag: "appt-" + a.id });

  const { data: subs } = await sb.from("push_subscriptions").select("*").in("user_id", targets);
  let sent = 0;
  await Promise.all((subs || []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await sb.from("push_subscriptions").delete().eq("id", s.id); // устройство отписалось
    }
  }));
  return Response.json({ sent });
});
