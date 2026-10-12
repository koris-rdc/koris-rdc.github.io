// Koris — envoie une notification sur le téléphone du destinataire
// (nouveau message privé ou nouveau commentaire sur sa publication).
// Déclenché par les « Database Webhooks » de Supabase (tables msgs et comments).
// Secrets à créer dans Supabase > Edge Functions > Secrets :
//   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (ex. mailto:ton@email.com)
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") || "mailto:aide@koris.cd",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

async function firstName(id: string) {
  const { data } = await sb.from("profiles").select("data").eq("id", id).maybeSingle();
  return (data?.data?.firstName as string) || "Quelqu'un";
}

Deno.serve(async (req) => {
  try {
    const p = await req.json();
    const rec = p.record || {};
    let to: string | null = null, title = "Koris", body = "", url = "/", tag = "koris";

    if (p.table === "msgs") {
      const { data: chat } = await sb.from("chats").select("members").eq("id", rec.chat_id).maybeSingle();
      to = (chat?.members || []).find((m: string) => m !== rec.from_id) || null;
      title = "💬 " + (await firstName(rec.from_id));
      body = String(rec.data?.text || "Nouveau message").slice(0, 140);
      url = "/?chat=" + rec.from_id;
      tag = "chat-" + rec.chat_id;
    } else if (p.table === "comments") {
      const postId = rec.data?.postId;
      if (postId) {
        const { data: post } = await sb.from("posts").select("uid").eq("id", postId).maybeSingle();
        if (post && post.uid !== rec.uid) to = post.uid;
      }
      title = "💚 " + (await firstName(rec.uid)) + " a commenté ta publication";
      body = String(rec.data?.text || "").slice(0, 140);
      tag = "cm-" + postId;
    }
    if (!to) return new Response("rien à envoyer");

    const { data: subs } = await sb.from("push_subs").select("endpoint,sub").eq("uid", to);
    const payload = JSON.stringify({ title, body, url, tag });
    await Promise.all((subs || []).map(async (s: { endpoint: string; sub: webpush.PushSubscription }) => {
      try { await webpush.sendNotification(s.sub, payload, { TTL: 86400 }); }
      catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) await sb.from("push_subs").delete().eq("endpoint", s.endpoint);
      }
    }));
    return new Response("ok");
  } catch (e) {
    return new Response("erreur : " + String(e), { status: 500 });
  }
});
