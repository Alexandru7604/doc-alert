import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push";
import nodemailer from "npm:nodemailer";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VAPID_PUBLIC = Deno.env.get("VAPID_PUBLIC")!;
const VAPID_PRIVATE = Deno.env.get("VAPID_PRIVATE")!;
const VAPID_SUBJECT = Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@docAlert.ro";
const TIMEZONE = Deno.env.get("TIMEZONE") ?? "Europe/Bucharest";
const GMAIL_USER = Deno.env.get("GMAIL_USER");
const GMAIL_APP_PASSWORD = Deno.env.get("GMAIL_APP_PASSWORD");

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);

function getLocalDateAndHour(tz: string): { date: string; hour: number } {
  const now = new Date();
  const localStr = now.toLocaleString("en-CA", { timeZone: tz, hour12: false });
  const [datePart, timePart] = localStr.split(", ");
  // toLocaleString poate returna "24:xx:xx" la miezul nopții — normalizăm cu % 24
  const hour = parseInt(timePart.split(":")[0], 10) % 24;
  return { date: datePart, hour };
}

function buildEmailHtml(
  title: string,
  memberName: string,
  docType: string,
  expiryDate: string,
  daysLeft: number,
  memberId: string,
  docId: string,
): string {
  const icon = daysLeft <= 0 ? "⛔" : "⚠️";
  const statusColor = daysLeft < 0 ? "#e17055" : daysLeft === 0 ? "#e17055" : daysLeft <= 7 ? "#e6a817" : "#00b894";
  const statusText =
    daysLeft < 0
      ? `Expirat de ${Math.abs(daysLeft)} zile`
      : daysLeft === 0
      ? "Expiră astăzi"
      : `Expiră în ${daysLeft} zile`;

  return `<!DOCTYPE html>
<html lang="ro">
<head><meta charset="UTF-8"><title>${title}</title></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f5f5f5;margin:0;padding:20px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 20px rgba(0,0,0,.1);">
    <div style="background:linear-gradient(135deg,#b07800,#d4a000);padding:28px 24px;text-align:center;">
      <div style="font-size:40px;margin-bottom:8px;">${icon}</div>
      <h1 style="color:#fff;margin:0;font-size:20px;font-weight:800;">DOC Alert</h1>
    </div>
    <div style="padding:28px 24px;">
      <div style="background:${statusColor}22;border-left:4px solid ${statusColor};border-radius:8px;padding:16px;margin-bottom:20px;">
        <div style="color:${statusColor};font-weight:800;font-size:16px;">${statusText}</div>
        ${memberName ? `<div style="color:#636e72;font-size:14px;margin-top:4px;">${memberName}</div>` : ""}
      </div>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;color:#636e72;font-size:13px;width:45%;">Tip document</td>
          <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;font-weight:700;">${docType}</td>
        </tr>
        <tr>
          <td style="padding:10px 0;color:#636e72;font-size:13px;">Data expirare</td>
          <td style="padding:10px 0;font-weight:700;color:${statusColor};">${expiryDate}</td>
        </tr>
      </table>
      <div style="margin-top:24px;text-align:center;">
        <a href="https://Alexandru7604.github.io/doc-alert/?member=${memberId}&doc=${docId}"
           style="display:inline-block;background:#b07800;color:#fff;text-decoration:none;padding:12px 28px;border-radius:50px;font-weight:700;font-size:15px;">
          Deschide DOC Alert
        </a>
      </div>
    </div>
    <div style="background:#f9f9f9;padding:16px 24px;text-align:center;font-size:12px;color:#b2bec3;">
      DOC Alert — gestionează documentele tale cu ușurință
    </div>
  </div>
</body>
</html>`;
}

serve(async (req) => {
  // Verificare Authorization — blochează apeluri neautorizate
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
    .select("id, user_id, member_id, doc_type, expiry_date, alert_days, notify_hour, mentiuni, members(name)");

  if (docsError) {
    return new Response(JSON.stringify({ error: docsError.message }), { status: 500 });
  }

  if (!docs || docs.length === 0) {
    return new Response(JSON.stringify({ sent: [] }), { status: 200 });
  }

  // Inițializează transportul Gmail SMTP (doar dacă sunt setate credențialele)
  let transporter: ReturnType<typeof nodemailer.createTransport> | null = null;
  if (GMAIL_USER && GMAIL_APP_PASSWORD) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false, // STARTTLS
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }

  const results: unknown[] = [];

  for (const doc of docs) {
    const expiryMs = new Date(doc.expiry_date).getTime();
    const daysLeft = Math.ceil((expiryMs - todayMs) / 86400000);

    if (daysLeft > doc.alert_days) continue;
    if (doc.notify_hour !== currentHour) continue;

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

    // ── Web Push ──────────────────────────────────────────────────────────────
    const { data: subs } = await sb
      .from("push_subscriptions")
      .select("endpoint, subscription")
      .eq("user_id", doc.user_id);

    if (subs && subs.length > 0) {
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
          results.push({ doc: doc.doc_type, channel: "push", endpoint, status: "sent" });
        } catch (err: unknown) {
          const status = (err as { statusCode?: number }).statusCode;
          results.push({ doc: doc.doc_type, channel: "push", endpoint, status: status ?? "error" });
          if (status === 410 || status === 404) {
            await sb.from("push_subscriptions").delete().eq("endpoint", endpoint);
          }
        }
      }
    }

    // ── Email Gmail SMTP ──────────────────────────────────────────────────────
    if (transporter) {
      // Folosim "email:<user_id>" ca cheie unică în notification_log pentru email
      const emailKey = `email:${doc.user_id}`;

      const { data: emailAlreadySent } = await sb
        .from("notification_log")
        .select("id")
        .eq("document_id", doc.id)
        .eq("subscription_endpoint", emailKey)
        .eq("sent_for_date", today)
        .maybeSingle();

      if (!emailAlreadySent) {
        // Obține emailul utilizatorului din Supabase Auth (necesită service role key)
        const { data: userData } = await sb.auth.admin.getUserById(doc.user_id);
        const userEmail = userData?.user?.email;

        if (userEmail) {
          try {
            await transporter.sendMail({
              from: `"DOC Alert" <${GMAIL_USER}>`,
              to: userEmail,
              subject: title,
              text: body,
              html: buildEmailHtml(title, memberName, doc.doc_type, doc.expiry_date, daysLeft, doc.member_id, doc.id),
            });
            await sb.from("notification_log").insert({
              document_id: doc.id,
              user_id: doc.user_id,
              subscription_endpoint: emailKey,
              sent_for_date: today,
            });
            results.push({ doc: doc.doc_type, channel: "email", to: userEmail, status: "sent" });
          } catch (err: unknown) {
            results.push({
              doc: doc.doc_type,
              channel: "email",
              to: userEmail,
              status: "error",
              error: String(err),
            });
          }
        }
      }
    }
  }

  return new Response(JSON.stringify({ sent: results }), { status: 200 });
});
