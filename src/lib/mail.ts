import { Resend } from 'resend';

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const FROM = process.env.MAIL_FROM ?? 'FoodShare <onboarding@resend.dev>';

const BG = '#FBF8F4';
const SURFACE = '#FFFFFF';
const TEXT = '#1A1A18';
const TEXT_DIM = '#7B7A75';
const ACCENT = '#A4B797';
const BORDER = '#EDE7DC';

function shell(title: string, intro: string, code: string, footer: string) {
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title></head>
<body style="margin:0;padding:0;background:${BG};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:${TEXT};">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};padding:40px 20px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:${SURFACE};border:1px solid ${BORDER};border-radius:14px;padding:40px 32px;">
        <tr><td>
          <div style="font-style:italic;font-size:24px;color:${TEXT};margin-bottom:32px;">FoodShare</div>
          <h1 style="font-size:22px;font-weight:600;margin:0 0 12px;color:${TEXT};">${title}</h1>
          <p style="font-size:14px;line-height:1.55;color:${TEXT_DIM};margin:0 0 28px;">${intro}</p>
          <div style="text-align:center;background:${BG};border:1px solid ${BORDER};border-radius:10px;padding:24px;margin-bottom:24px;">
            <div style="font-size:11px;letter-spacing:2px;color:${TEXT_DIM};margin-bottom:8px;">CODE</div>
            <div style="font-size:34px;font-weight:600;letter-spacing:8px;color:${TEXT};font-family:ui-monospace,SFMono-Regular,Menlo,monospace;">${code}</div>
          </div>
          <p style="font-size:12px;line-height:1.5;color:${TEXT_DIM};margin:0;">${footer}</p>
        </td></tr>
      </table>
      <p style="font-size:11px;color:${TEXT_DIM};margin-top:20px;">Tu reçois ce mail parce qu'une action a été demandée sur FoodShare. Si ce n'est pas toi, ignore-le.</p>
    </td></tr>
  </table>
</body></html>`;
}

function tplVerify(name: string, code: string) {
  return shell(
    'Confirme ton adresse',
    `Bienvenue ${name} ! Pour finaliser ton inscription, entre ce code dans l'app FoodShare.`,
    code,
    'Ce code expire dans 15 minutes. Si tu n\'as pas créé de compte, ignore ce mail.',
  );
}

function tplReset(name: string, code: string) {
  return shell(
    'Réinitialise ton mot de passe',
    `Bonjour ${name}, voici le code pour choisir un nouveau mot de passe.`,
    code,
    'Ce code expire dans 15 minutes. Si tu n\'as rien demandé, ignore ce mail — ton compte reste protégé.',
  );
}

export async function sendVerificationEmail(to: string, name: string, code: string) {
  if (!resend) {
    console.log(`[mail:dev] verification code for ${to} (${name}): ${code}`);
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: 'Confirme ton adresse FoodShare',
      html: tplVerify(name, code),
    });
  } catch (e) {
    console.error('[mail] sendVerificationEmail failed', e);
  }
}

export async function sendResetEmail(to: string, name: string, code: string) {
  if (!resend) {
    console.log(`[mail:dev] reset code for ${to} (${name}): ${code}`);
    return;
  }
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: 'Réinitialise ton mot de passe FoodShare',
      html: tplReset(name, code),
    });
  } catch (e) {
    console.error('[mail] sendResetEmail failed', e);
  }
}
