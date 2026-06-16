require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');
const { neon } = require('@neondatabase/serverless');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const sql = neon(process.env.DATABASE_URL);

function getOrganizerId(req) {
  return req.body?.organizerId || req.query?.organizerId || null;
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
      const session = event.data.object;

      if (session.mode === 'subscription' && session.metadata?.type === 'organizer_subscription') {
        await sql`
          UPDATE organizers
          SET
            stripe_customer_id = ${session.customer || null},
            stripe_subscription_id = ${session.subscription || null},
            subscription_status = 'active'
          WHERE id = ${session.metadata.organizerId}
        `;

        console.log('✅ Organizer subscription activated');
        console.log('Organizer ID:', session.metadata.organizerId);
      }

      if (session.mode === 'payment' && session.metadata?.type === 'league_registration') {
        const email =
          session.customer_details?.email ||
          session.customer_email ||
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
            ${session.id},
            ${event.id},
            ${session.metadata?.organizerId || null},
            ${session.metadata?.leagueDbId || null},
            ${email},
            ${session.metadata?.fullName || ''},
            ${session.metadata?.leagueSlug || ''},
            ${session.metadata?.skillLevel || ''},
            ${session.payment_status || 'paid'},
            ${session.amount_total || 0}
          )
          ON CONFLICT (stripe_event_id) DO NOTHING
        `;

        console.log('✅ Player registration saved to database');
        console.log('Session ID:', session.id);
        console.log('Customer email:', email);
        console.log('Organizer ID:', session.metadata?.organizerId);
        console.log('League DB ID:', session.metadata?.leagueDbId);
        console.log('League slug:', session.metadata?.leagueSlug);
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
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'views', 'login.html')));
app.get('/join', (req, res) => res.sendFile(path.join(__dirname, 'views', 'join.html')));
app.get('/create', (req, res) => res.sendFile(path.join(__dirname, 'views', 'create.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'views', 'success.html')));
app.get('/cancel', (req, res) => res.sendFile(path.join(__dirname, 'views', 'cancel.html')));

app.get('/organizer/billing-success', (req, res) => {
  res.send('Organizer subscription active. You can now connect Stripe payouts.');
});

app.get('/organizer/billing-cancel', (req, res) => {
  res.send('Organizer subscription checkout cancelled.');
});

app.get('/organizer/dashboard', async (req, res) => {
  try {
    const organizers = await sql`
      SELECT id, email, name, subscription_status, stripe_account_id, onboarding_complete
      FROM organizers
      ORDER BY created_at DESC
      LIMIT 20
    `;

    const leagues = await sql`
      SELECT l.id, l.organizer_id, l.name, l.slug, l.price, l.status, o.name AS organizer_name
      FROM leagues l
      JOIN organizers o ON o.id = l.organizer_id
      ORDER BY l.created_at DESC
      LIMIT 50
    `;

    return res.json({ organizers, leagues });
  } catch (err) {
    console.error('Dashboard error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.post('/login', (req, res) => {
  res.redirect('/success');
});

app.post('/create', (req, res) => {
  res.redirect('/success');
});

app.post('/organizer/signup', async (req, res) => {
  try {
    const { name, email } = req.body;

    if (!name || !email) {
      return res.status(400).send('Name and email are required.');
    }

    const existing = await sql`
      SELECT id
      FROM organizers
      WHERE email = ${email}
      LIMIT 1
    `;

    if (existing.length) {
      return res.status(400).send('Organizer with this email already exists.');
    }

    const rows = await sql`
      INSERT INTO organizers (name, email)
      VALUES (${name}, ${email})
      RETURNING id, name, email
    `;

    return res.json({
      message: 'Organizer created successfully',
      organizer: rows[0]
    });
  } catch (err) {
    console.error('Organizer signup error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.post('/organizer/subscribe', async (req, res) => {
  try {
    const organizerId = getOrganizerId(req);

    if (!organizerId) {
      return res.status(400).send('Organizer ID is required.');
    }

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

    const session = await stripe.checkout.sessions.create({
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

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Organizer subscription error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.all('/organizer/connect/start', async (req, res) => {
  try {
    const organizerId = getOrganizerId(req);

    if (!organizerId) {
      return res.status(400).send('Organizer ID is required.');
    }

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

    const accountLink = await stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: `${BASE_URL}/organizer/connect/refresh?organizerId=${organizer.id}`,
      return_url: `${BASE_URL}/organizer/connect/return?organizerId=${organizer.id}`,
      type: 'account_onboarding'
    });

    return res.redirect(303, accountLink.url);
  } catch (err) {
    console.error('Connect onboarding error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.get('/organizer/connect/refresh', async (req, res) => {
  try {
    const organizerId = getOrganizerId(req);

    if (!organizerId) {
      return res.status(400).send('Organizer ID is required.');
    }

    return res.redirect(303, `/organizer/connect/start?organizerId=${organizerId}`);
  } catch (err) {
    console.error('Connect refresh error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.get('/organizer/connect/return', async (req, res) => {
  try {
    const organizerId = getOrganizerId(req);

    if (!organizerId) {
      return res.status(400).send('Organizer ID is required.');
    }

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

    return res.send(`Stripe onboarding return complete. details_submitted=${account.details_submitted}`);
  } catch (err) {
    console.error('Connect return error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.post('/organizer/leagues/create', async (req, res) => {
  try {
    const { organizerId, name, slug, price } = req.body;

    if (!organizerId || !name || !slug || !price) {
      return res.status(400).send('organizerId, name, slug, and price are required.');
    }

    const organizerRows = await sql`
      SELECT id, subscription_status
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

    const session = await stripe.checkout.sessions.create({
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

    return res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err.message);
    return res.status(500).send(err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on ${BASE_URL}`);
});