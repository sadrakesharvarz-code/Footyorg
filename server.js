require('dotenv').config();
const path = require('path');
const express = require('express');
const Stripe = require('stripe');
const { neon } = require('@neondatabase/serverless');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const sql = neon(process.env.DATABASE_URL);

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

      const email =
        session.customer_details?.email ||
        session.customer_email ||
        '';

      await sql`
        INSERT INTO registrations (
          stripe_session_id,
          stripe_event_id,
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
          ${email},
          ${session.metadata?.fullName || ''},
          ${session.metadata?.leagueId || ''},
          ${session.metadata?.skillLevel || ''},
          ${session.payment_status || 'paid'},
          ${session.amount_total || 0}
        )
        ON CONFLICT (stripe_event_id) DO NOTHING
      `;

      console.log('✅ Payment completed and saved to database');
      console.log('Session ID:', session.id);
      console.log('Customer email:', email);
      console.log('League ID:', session.metadata?.leagueId);
      console.log('Full name:', session.metadata?.fullName);
      console.log('Skill level:', session.metadata?.skillLevel);
      console.log('Amount:', session.amount_total);
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Database save failed:', err.message);
    res.status(500).send('Webhook handler failed');
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

app.post('/login', (req, res) => {
  res.redirect('/success');
});

app.post('/create', (req, res) => {
  res.redirect('/success');
});

app.post('/checkout', async (req, res) => {
  try {
    const { fullName, email, leagueId, skillLevel, waiver } = req.body;

    if (!waiver) {
      return res.status(400).send('You must accept the waiver.');
    }

    const leagues = {
      'downtown-7v7': { name: 'Downtown 7v7', price: 12900 },
      'midtown-futsal': { name: 'Midtown Futsal', price: 9900 },
      'scarborough-11v11': { name: 'Scarborough 11v11', price: 14500 }
    };

    const league = leagues[leagueId] || leagues['downtown-7v7'];

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
      metadata: {
        fullName,
        skillLevel,
        leagueId
      },
      success_url: `${BASE_URL}/success`,
      cancel_url: `${BASE_URL}/cancel`
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error('Checkout error:', err.message);
    res.status(500).send(err.message);
  }
});

app.listen(PORT, () => console.log(`Server listening on http://localhost:${PORT}`));