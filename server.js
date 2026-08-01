require('dotenv').config();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const Stripe = require('stripe');
const { neon } = require('@neondatabase/serverless');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const sql = neon(process.env.DATABASE_URL);

const CONNECT_STATE_SECRET =
  process.env.CONNECT_STATE_SECRET ||
  process.env.SESSION_SECRET ||
  'dev-connect-state-secret-change-me';

function base64urlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function base64urlDecode(input) {
  let normalized = String(input).replace(/-/g, '+').replace(/_/g, '/');
  while (normalized.length % 4) normalized += '=';
  return Buffer.from(normalized, 'base64').toString('utf8');
}

function signValue(value) {
  return crypto
    .createHmac('sha256', CONNECT_STATE_SECRET)
    .update(value)
    .digest('hex');
}

function createConnectStateToken(organizerId) {
  const payload = JSON.stringify({
    organizerId: Number(organizerId),
    exp: Date.now() + 1000 * 60 * 30
  });

  const encodedPayload = base64urlEncode(payload);
  const signature = signValue(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyConnectStateToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return null;
  }

  const [encodedPayload, providedSignature] = token.split('.');

  if (!encodedPayload || !providedSignature) {
    return null;
  }

  const expectedSignature = signValue(encodedPayload);
  const providedBuffer = Buffer.from(providedSignature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(base64urlDecode(encodedPayload));

    if (!payload?.organizerId || !payload?.exp) {
      return null;
    }

    if (Date.now() > Number(payload.exp)) {
      return null;
    }

    return {
      organizerId: Number(payload.organizerId)
    };
  } catch {
    return null;
  }
}

app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const checkoutSession = event.data.object;

      if (checkoutSession.mode === 'subscription' && checkoutSession.metadata?.type === 'organizer_subscription') {
        await sql`
          UPDATE organizers
          SET
            stripe_customer_id = ${checkoutSession.customer || null},
            stripe_subscription_id = ${checkoutSession.subscription || null},
            subscription_status = 'active'
          WHERE id = ${checkoutSession.metadata.organizerId}
        `;
      }

      if (checkoutSession.mode === 'payment' && checkoutSession.metadata?.type === 'league_registration') {
        const email =
          checkoutSession.customer_details?.email ||
          checkoutSession.customer_email ||
          '';

        await sql`
          INSERT INTO registrations (
            stripe_session_id,
            stripe_event_id,
            organizer_id,
            league_db_id,
            email,
            full_name,
            league_id,
            skill_level,
            payment_status,
            amount
          )
          VALUES (
            ${checkoutSession.id},
            ${event.id},
            ${checkoutSession.metadata?.organizerId || null},
            ${checkoutSession.metadata?.leagueDbId || null},
            ${email},
            ${checkoutSession.metadata?.fullName || ''},
            ${checkoutSession.metadata?.leagueSlug || ''},
            ${checkoutSession.metadata?.skillLevel || ''},
            ${checkoutSession.payment_status || 'paid'},
            ${checkoutSession.amount_total || 0}
          )
          ON CONFLICT (stripe_event_id) DO NOTHING
        `;
      }
    }

    return res.json({ received: true });
  } catch (err) {
    console.error('Webhook handler failed:', err.message);
    return res.status(500).send('Webhook handler failed');
  }
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.set('trust proxy', 1);

app.use(session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  proxy: process.env.NODE_ENV === 'production',
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

function requireOrganizerAuth(req, res, next) {
  if (req.session?.organizerId) {
    return next();
  }

  const wantsJson =
    req.xhr ||
    (req.headers.accept || '').includes('application/json') ||
    (req.headers['content-type'] || '').includes('application/json');

  if (wantsJson) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.redirect('/login');
}

function getSessionOrganizerId(req) {
  return req.session?.organizerId || null;
}

function requirePlayerAuth(req, res, next) {
  if (req.session?.playerId) {
    return next();
  }

  const wantsJson =
    req.xhr ||
    (req.headers.accept || '').includes('application/json') ||
    (req.headers['content-type'] || '').includes('application/json');

  if (wantsJson) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.redirect('/player/login');
}

function getSessionPlayerId(req) {
  return req.session?.playerId || null;
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'views', 'join.html')));
app.get('/create', (req, res) => res.sendFile(path.join(__dirname, 'views', 'create.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'views', 'success.html')));
app.get('/cancel', (req, res) => res.sendFile(path.join(__dirname, 'views', 'cancel.html')));

app.post('/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.redirect('/login?error=Please%20enter%20your%20email%20and%20password');
    }

    const rows = await sql`
      SELECT id, email, name, password_hash
      FROM organizers
      WHERE lower(email) = ${email}
      LIMIT 1
    `;

    const organizer = rows[0];

    if (!organizer || !organizer.password_hash) {
      return res.redirect('/login?error=Invalid%20email%20or%20password');
    }

    const passwordOk = await bcrypt.compare(password, organizer.password_hash);

    if (!passwordOk) {
      return res.redirect('/login?error=Invalid%20email%20or%20password');
    }

    req.session.organizerId = organizer.id;
    req.session.organizerEmail = organizer.email;
    req.session.organizerName = organizer.name;

    return res.redirect('/organizer');
  } catch (err) {
    console.error('Login error:', err.message);
    return res.redirect('/login?error=Login%20failed');
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.post('/create', (req, res) => {
  res.redirect('/success');
});

app.post('/organizer/signup', async (req, res) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!name || !email || !password) {
      return res.status(400).send('Name, email, and password are required.');
    }

    if (password.length < 8) {
      return res.status(400).send('Password must be at least 8 characters.');
    }

    const existing = await sql`
      SELECT id
      FROM organizers
      WHERE lower(email) = ${email}
      LIMIT 1
    `;

    if (existing.length) {
      return res.status(400).send('Organizer with this email already exists.');
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const rows = await sql`
      INSERT INTO organizers (name, email, password_hash)
      VALUES (${name}, ${email}, ${passwordHash})
      RETURNING id, name, email
    `;

    const organizer = rows[0];

    req.session.organizerId = organizer.id;
    req.session.organizerEmail = organizer.email;
    req.session.organizerName = organizer.name;

    return res.redirect('/organizer');
  } catch (err) {
    console.error('Organizer signup error:', err.message);
    return res.status(500).send('Organizer signup failed.');
  }
});

app.post('/player/signup', async (req, res) => {
  try {
    const fullName = String(req.body?.fullName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const phone = String(req.body?.phone || '').trim();

    if (!fullName || !email || !password) {
      return res.redirect('/player/create?error=' + encodeURIComponent('Please enter your full name, email, and password.'));
    }

    if (password.length < 6) {
      return res.redirect('/player/create?error=' + encodeURIComponent('Password must be at least 6 characters long.'));
    }

    const existing = await sql`
      SELECT id
      FROM players
      WHERE lower(email) = ${email}
      LIMIT 1
    `;

    if (existing.length) {
      return res.redirect('/player/create?error=' + encodeURIComponent('A player account already exists for that email address.'));
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const rows = await sql`
      INSERT INTO players (full_name, email, phone, password_hash)
      VALUES (${fullName}, ${email}, ${phone}, ${passwordHash})
      RETURNING id, full_name, email
    `;

    const player = rows[0];

    req.session.playerId = player.id;
    req.session.playerEmail = player.email;
    req.session.playerName = player.full_name;

    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error after player signup:', saveErr.message);
      }
      return res.redirect('/player');
    });
  } catch (err) {
    console.error('Player signup error:', err.message);
    return res.redirect('/player/create?error=' + encodeURIComponent('Player signup failed. Please try again in a moment.'));
  }
});

app.post('/player/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.redirect('/player/login?error=Please%20enter%20your%20email%20and%20password');
    }

    const rows = await sql`
      SELECT id, email, full_name, password_hash
      FROM players
      WHERE lower(email) = ${email}
      LIMIT 1
    `;

    const player = rows[0];

    if (!player || !player.password_hash) {
      return res.redirect('/player/login?error=Invalid%20email%20or%20password');
    }

    const passwordOk = await bcrypt.compare(password, player.password_hash);

    if (!passwordOk) {
      return res.redirect('/player/login?error=Invalid%20email%20or%20password');
    }

    req.session.playerId = player.id;
    req.session.playerEmail = player.email;
    req.session.playerName = player.full_name;

    return req.session.save((saveErr) => {
      if (saveErr) {
        console.error('Session save error after player login:', saveErr.message);
      }
      return res.redirect('/player');
    });
  } catch (err) {
    console.error('Player login error:', err.message);
    return res.redirect('/player/login?error=Login%20failed');
  }
});

app.post('/player/logout', (req, res) => {
  if (req.session) {
    delete req.session.playerId;
    delete req.session.playerEmail;
    delete req.session.playerName;
  }

  return res.redirect('/');
});

app.get('/player/dashboard-data', requirePlayerAuth, async (req, res) => {
  try {
    const playerId = getSessionPlayerId(req);

    const playerRows = await sql`
      SELECT id, full_name, email, phone
      FROM players
      WHERE id = ${playerId}
      LIMIT 1
    `;

    const player = playerRows[0] || null;

    const regs = await sql`
      SELECT id, league_id, full_name, email, payment_status, amount
      FROM registrations
      WHERE lower(email) = ${player?.email || ''}
      ORDER BY id DESC
      LIMIT 50
    `;

    return res.json({ player, registrations: regs });
  } catch (err) {
    console.error('Player dashboard error:', err.message);
    return res.status(500).send('Failed to load player dashboard.');
  }
});

app.get('/organizer', requireOrganizerAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'organizer.html'));
});

app.get('/player/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'player-login.html')));
app.get('/player/create', (req, res) => res.sendFile(path.join(__dirname, 'views', 'player-create.html')));
app.get('/player', requirePlayerAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

app.get('/auth/status', (req, res) => {
  const organizer = req.session?.organizerId
    ? {
        id: req.session.organizerId,
        email: req.session.organizerEmail || null,
        name: req.session.organizerName || null
      }
    : null;

  const player = req.session?.playerId
    ? {
        id: req.session.playerId,
        email: req.session.playerEmail || null,
        full_name: req.session.playerName || null
      }
    : null;

  if (!organizer && !player) {
    return res.status(401).json({ authenticated: false });
  }

  return res.json({ authenticated: true, organizer, player });
});

app.get('/organizer/billing-success', requireOrganizerAuth, (req, res) => {
  return res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Subscription Activated</title>
      <meta http-equiv="refresh" content="3;url=/organizer" />
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f7f6f2;
          color: #28251d;
          min-height: 100vh;
          margin: 0;
          display: grid;
          place-items: center;
          padding: 24px;
        }
        .card {
          width: 100%;
          max-width: 640px;
          background: #fff;
          border: 1px solid #ddd7cf;
          border-radius: 20px;
          padding: 32px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.06);
          text-align: center;
        }
        h1 {
          margin: 0 0 12px;
          font-size: 2rem;
        }
        p {
          margin: 0 0 14px;
          line-height: 1.6;
          color: #5c5a54;
        }
        a {
          display: inline-block;
          margin-top: 10px;
          background: #0f7c82;
          color: white;
          text-decoration: none;
          padding: 12px 18px;
          border-radius: 999px;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Subscription activated</h1>
        <p>Your organizer subscription was successful.</p>
        <p>You’ll be redirected back to your dashboard in a few seconds.</p>
        <a href="/organizer">Return to dashboard</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/organizer/billing-cancel', requireOrganizerAuth, (req, res) => {
  return res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Subscription Cancelled</title>
      <meta http-equiv="refresh" content="3;url=/organizer" />
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #f7f6f2;
          color: #28251d;
          min-height: 100vh;
          margin: 0;
          display: grid;
          place-items: center;
          padding: 24px;
        }
        .card {
          width: 100%;
          max-width: 640px;
          background: #fff;
          border: 1px solid #ddd7cf;
          border-radius: 20px;
          padding: 32px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.06);
          text-align: center;
        }
        h1 {
          margin: 0 0 12px;
          font-size: 2rem;
        }
        p {
          margin: 0 0 14px;
          line-height: 1.6;
          color: #5c5a54;
        }
        a {
          display: inline-block;
          margin-top: 10px;
          background: #0f7c82;
          color: white;
          text-decoration: none;
          padding: 12px 18px;
          border-radius: 999px;
          font-weight: 600;
        }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Subscription cancelled</h1>
        <p>Your subscription checkout was cancelled.</p>
        <p>You’ll be redirected back to your dashboard in a few seconds.</p>
        <a href="/organizer">Return to dashboard</a>
      </div>
    </body>
    </html>
  `);
});

app.get('/organizer/dashboard', requireOrganizerAuth, async (req, res) => {
  try {
    const organizerId = getSessionOrganizerId(req);

    const organizerRows = await sql`
      SELECT id, email, name, subscription_status, stripe_account_id, onboarding_complete
      FROM organizers
      WHERE id = ${organizerId}
      LIMIT 1
    `;

    const leagues = await sql`
      SELECT l.id, l.organizer_id, l.name, l.slug, l.price, l.status, o.name AS organizer_name
      FROM leagues l
      JOIN organizers o ON o.id = l.organizer_id
      WHERE l.organizer_id = ${organizerId}
      ORDER BY l.created_at DESC
    `;

    return res.json({
      organizer: organizerRows[0] || null,
      leagues
    });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.post('/organizer/subscribe', requireOrganizerAuth, async (req, res) => {
  try {
    const organizerId = getSessionOrganizerId(req);

    if (!process.env.STRIPE_ORGANIZER_PRICE_ID) {
      return res.status(500).send('Missing STRIPE_ORGANIZER_PRICE_ID env var.');
    }

    const rows = await sql`
      SELECT id, email, name
      FROM organizers
      WHERE id = ${organizerId}
      LIMIT 1
    `;

    const organizer = rows[0];

    if (!organizer) {
      return res.status(404).send('Organizer not found.');
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer_email: organizer.email,
      line_items: [
        {
          price: process.env.STRIPE_ORGANIZER_PRICE_ID,
          quantity: 1
        }
      ],
      metadata: {
        type: 'organizer_subscription',
        organizerId: String(organizer.id)
      },
      success_url: `${BASE_URL}/organizer/billing-success`,
      cancel_url: `${BASE_URL}/organizer/billing-cancel`
    });

    return res.redirect(303, checkoutSession.url);
  } catch (err) {
    console.error('Organizer subscription error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.get('/auth/status', (req, res) => {
  if (req.session?.organizerId) {
    return res.json({
      authenticated: true,
      organizer: {
        id: req.session.organizerId,
        email: req.session.organizerEmail || null,
        name: req.session.organizerName || null
      }
    });
  }

  return res.status(401).json({ authenticated: false });
});

app.all('/organizer/connect/start', requireOrganizerAuth, async (req, res) => {
  try {
    const organizerId = getSessionOrganizerId(req);

    const rows = await sql`
      SELECT id, email, name, stripe_account_id, subscription_status
      FROM organizers
      WHERE id = ${organizerId}
      LIMIT 1
    `;

    const organizer = rows[0];

    if (!organizer) {
      return res.status(404).send('Organizer not found.');
    }

    if (organizer.subscription_status !== 'active') {
      return res.status(400).send('Organizer must have an active subscription before connecting payouts.');
    }

    let stripeAccountId = organizer.stripe_account_id;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: organizer.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      stripeAccountId = account.id;

      await sql`
        UPDATE organizers
        SET stripe_account_id = ${stripeAccountId}
        WHERE id = ${organizer.id}
      `;
    }

    const state = createConnectStateToken(organizer.id);

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${BASE_URL}/organizer/connect/refresh?state=${encodeURIComponent(state)}`,
      return_url: `${BASE_URL}/organizer/connect/return?state=${encodeURIComponent(state)}`,
      type: 'account_onboarding'
    });

    return res.json({ url: accountLink.url });
  } catch (err) {
    console.error('Connect onboarding error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.get('/organizer/connect/refresh', async (req, res) => {
  try {
    const verified = verifyConnectStateToken(req.query.state);

    if (!verified?.organizerId) {
      return res.status(400).send('Invalid or expired connect state.');
    }

    const organizerId = verified.organizerId;

    const rows = await sql`
      SELECT id, email, name, stripe_account_id, subscription_status
      FROM organizers
      WHERE id = ${organizerId}
      LIMIT 1
    `;

    const organizer = rows[0];

    if (!organizer) {
      return res.status(404).send('Organizer not found.');
    }

    if (organizer.subscription_status !== 'active') {
      return res.status(400).send('Organizer must have an active subscription before connecting payouts.');
    }

    let stripeAccountId = organizer.stripe_account_id;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        type: 'express',
        email: organizer.email,
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true }
        }
      });

      stripeAccountId = account.id;

      await sql`
        UPDATE organizers
        SET stripe_account_id = ${stripeAccountId}
        WHERE id = ${organizer.id}
      `;
    }

    const state = createConnectStateToken(organizer.id);

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${BASE_URL}/organizer/connect/refresh?state=${encodeURIComponent(state)}`,
      return_url: `${BASE_URL}/organizer/connect/return?state=${encodeURIComponent(state)}`,
      type: 'account_onboarding'
    });

    return res.redirect(303, accountLink.url);
  } catch (err) {
    console.error('Connect refresh error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.get('/organizer/connect/return', async (req, res) => {
  try {
    const verified = verifyConnectStateToken(req.query.state);

    if (!verified?.organizerId) {
      return res.status(400).send('Invalid or expired connect state.');
    }

    const organizerId = verified.organizerId;

    const rows = await sql`
      SELECT id, stripe_account_id
      FROM organizers
      WHERE id = ${organizerId}
      LIMIT 1
    `;

    const organizer = rows[0];

    if (!organizer?.stripe_account_id) {
      return res.status(404).send('Organizer not found or Stripe account missing.');
    }

    const account = await stripe.accounts.retrieve(organizer.stripe_account_id);

    await sql`
      UPDATE organizers
      SET onboarding_complete = ${account.details_submitted || false}
      WHERE id = ${organizerId}
    `;

    if (req.session) {
      req.session.organizerId = organizerId;
    }

    return res.redirect('/organizer');
  } catch (err) {
    console.error('Connect return error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.post('/organizer/leagues/create', requireOrganizerAuth, async (req, res) => {
  try {
    const organizerId = getSessionOrganizerId(req);
    const { name, slug, price } = req.body;

    if (!name || !slug || !price) {
      return res.status(400).send('name, slug, and price are required.');
    }

    const organizerRows = await sql`
      SELECT id, subscription_status, onboarding_complete
      FROM organizers
      WHERE id = ${organizerId}
      LIMIT 1
    `;

    const organizer = organizerRows[0];

    if (!organizer) {
      return res.status(404).send('Organizer not found.');
    }

    if (organizer.subscription_status !== 'active') {
      return res.status(400).send('Organizer subscription must be active before creating leagues.');
    }

    if (!organizer.onboarding_complete) {
      return res.status(400).send('Connect Stripe payouts before creating leagues.');
    }

    const rows = await sql`
      INSERT INTO leagues (organizer_id, name, slug, price, status)
      VALUES (${organizerId}, ${name}, ${slug}, ${price}, 'active')
      RETURNING id, organizer_id, name, slug, price, status
    `;

    return res.json({
      message: 'League created successfully',
      league: rows[0]
    });
  } catch (err) {
    console.error('Create league error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.post('/checkout', async (req, res) => {
  try {
    const { fullName, email, leagueId, skillLevel, waiver } = req.body;

    if (!waiver) {
      return res.status(400).send('You must accept the waiver.');
    }

    if (!leagueId) {
      return res.status(400).send('League is required.');
    }

    const rows = await sql`
      SELECT
        l.id,
        l.name,
        l.slug,
        l.price,
        l.organizer_id,
        o.stripe_account_id,
        o.subscription_status,
        o.onboarding_complete
      FROM leagues l
      JOIN organizers o ON o.id = l.organizer_id
      WHERE l.slug = ${leagueId}
      LIMIT 1
    `;

    const league = rows[0];

    if (!league) {
      return res.status(404).send('League not found.');
    }

    if (league.subscription_status !== 'active') {
      return res.status(400).send('Organizer subscription is inactive.');
    }

    if (!league.stripe_account_id || !league.onboarding_complete) {
      return res.status(400).send('Organizer Stripe payouts are not ready yet.');
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'cad',
            product_data: {
              name: `${league.name} registration`
            },
            unit_amount: league.price
          },
          quantity: 1
        }
      ],
      payment_intent_data: {
        transfer_data: {
          destination: league.stripe_account_id
        }
      },
      metadata: {
        type: 'league_registration',
        organizerId: String(league.organizer_id),
        leagueDbId: String(league.id),
        leagueSlug: league.slug,
        fullName: fullName || '',
        skillLevel: skillLevel || ''
      },
      success_url: `${BASE_URL}/success`,
      cancel_url: `${BASE_URL}/cancel`
    });

    return res.redirect(303, checkoutSession.url);
  } catch (err) {
    console.error('Checkout error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
});