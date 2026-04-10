import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@docAlert.ro";
const TIMEZONE = Deno.env.get("TIMEZONE") ?? "Europe/Bucharest";

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

function getLocalDateAndHour(tz: string): { date: string; hour: number } {
  const now = new Date();
  const localStr = now.toLocaleString("en-CA", { timeZone: tz, hour12: false });
  const [datePart, timePart] = localStr.split(", ");
  const hour = parseInt(timePart.split(":")[0], 10);
  return { date: datePart, hour };
}

serve(async (req) => {
  // Verificare Authorization — blocheaza apeluri neautorizate
  const authHeader = req.headers.get("Authorization");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const { date: today, hour: currentHour } = getLocalDateAndHour(TIMEZONE);
  const todayMs = new Date(today).getTime();

  const { data: docs, error: docsError } = await sb
    .from("documents")
    .select("id, user_id, doc_type, expiry_date, alert_days, notify_hour, mentiuni, members(name)");

  if (docsError) {
    return new Response(JSON.stringify({ error: docsError.message }), { status: 500 });
  }

  if (!docs || docs.length === 0) {
    return new Response(JSON.stringify({ sent: [] }), { status: 200 });
  }

  const results = [];

  for (const doc of docs) {
    const expiryMs = new Date(doc.expiry_date).getTime();
    const daysLeft = Math.ceil((expiryMs - todayMs) / 86400000);

    if (daysLeft > doc.alert_days) continue;
    if (doc.notify_hour !== currentHour) continue;

    const { data: subs } = await sb
      .from("push_subscriptions")
      .select("endpoint, subscription")
      .eq("user_id", doc.user_id);

    if (!subs || subs.length === 0) continue;

    const memberName = (doc.members as { name?: string } | null)?.name ?? "";

    let title: string;
    let body: string;

    if (daysLeft < 0) {
      title = `⛔ DOC Alert — ${doc.doc_type} EXPIRAT`;
      body = `${memberName ? memberName + ": " : ""}${doc.doc_type} a expirat de ${Math.abs(daysLeft)} zile!`;
    } else if (daysLeft === 0) {
      title = `⛔ DOC Alert — ${doc.doc_type} expiră AZI`;
      body = `${memberName ? memberName + ": " : ""}${doc.doc_type} expiră astăzi!`;
    } else {
      title = `⚠️ DOC Alert — ${doc.doc_type}`;
      body = `${memberName ? memberName + ": " : ""}${doc.doc_type} expiră în ${daysLeft} zile (${doc.expiry_date})`;
    }

    const payload = JSON.stringify({
      title,
      body,
      tag: `doc-${doc.id}`,
      url: "/doc-alert/",
    });

    for (const subRow of subs) {
      const sub = subRow.subscription;
      const endpoint = subRow.endpoint;

      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) continue;

      const { data: alreadySent } = await sb
        .from("notification_log")
        .select("id")
        .eq("document_id", doc.id)
        .eq("subscription_endpoint", endpoint)
        .eq("sent_for_date", today)
        .maybeSingle();

      if (alreadySent) continue;

      try {
        await webpush.sendNotification(sub, payload);
        await sb.from("notification_log").insert({
          document_id: doc.id,
          user_id: doc.user_id,
          subscription_endpoint: endpoint,
          sent_for_date: today,
        });
        results.push({ doc: doc.doc_type, endpoint, status: "sent" });
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        results.push({ doc: doc.doc_type, endpoint, status: status ?? "error" });
        if (status === 410 || status === 404) {
          await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
        }
      }
    }
  }

  return new Response(JSON.stringify({ sent: results }), { status: 200 });
});
