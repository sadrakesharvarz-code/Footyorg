const organizerStatus = document.getElementById('organizerStatus');
const leaguesTable = document.getElementById('leaguesTable');
const refreshBtn = document.getElementById('refreshBtn');
const subscribeForm = document.getElementById('subscribeForm');
const subscribeBtn = document.getElementById('subscribeBtn');
const connectBtn = document.getElementById('connectBtn');
const connectMessage = document.getElementById('connectMessage');
const payoutStatus = document.getElementById('payoutStatus');
const leagueForm = document.getElementById('leagueForm');
const leagueMessage = document.getElementById('leagueMessage');
const leagueNameInput = document.getElementById('leagueName');
const leagueSlugInput = document.getElementById('leagueSlug');
const leaguePriceInput = document.getElementById('leaguePrice');

let currentOrganizer = null;

function centsToCadLabel(cents) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function statusText(row) {
  const active = row.subscription_status === 'active';
  const onboarding = row.onboarding_complete;

  return `
    <div><strong>ID:</strong> ${row.id}</div>
    <div><strong>Name:</strong> ${row.name || ''}</div>
    <div><strong>Email:</strong> ${row.email || ''}</div>
    <div><strong>Subscription:</strong> <span class="status ${active ? 'ok' : 'warn'}">${row.subscription_status || 'unknown'}</span></div>
    <div><strong>Stripe Account:</strong> ${row.stripe_account_id || 'not created yet'}</div>
    <div><strong>Onboarding:</strong> <span class="status ${onboarding ? 'ok' : 'warn'}">${onboarding ? 'complete' : 'incomplete'}</span></div>
  `;
}

function redirectToLogin() {
  window.location.href = '/login';
}

async function parseError(res) {
  try {
    const text = await res.text();
    return text || `Request failed with status ${res.status}`;
  } catch {
    return `Request failed with status ${res.status}`;
  }
}

function isHtmlResponse(res) {
  const contentType = res.headers.get('content-type') || '';
  return contentType.includes('text/html');
}

function resetActions() {
  subscribeForm.style.display = 'none';
  connectBtn.style.display = 'none';
  payoutStatus.style.display = 'none';
  connectMessage.textContent = '';
  connectMessage.className = 'message';
}

function updateActionState(organizer) {
  resetActions();

  if (!organizer) {
    connectMessage.textContent = 'Organizer not found.';
    connectMessage.className = 'message error';
    return;
  }

  const subscriptionActive = organizer.subscription_status === 'active';
  const onboardingComplete = !!organizer.onboarding_complete;

  if (!subscriptionActive) {
    subscribeForm.style.display = 'inline-block';
    connectMessage.textContent = 'Activate your subscription first. Once it is active, you can connect Stripe payouts.';
    connectMessage.className = 'message muted';
    return;
  }

  if (!onboardingComplete) {
    connectBtn.style.display = 'inline-block';
    connectMessage.textContent = 'Your subscription is active. Next step: connect Stripe payouts.';
    connectMessage.className = 'message muted';
    return;
  }

  payoutStatus.style.display = 'block';
  connectMessage.textContent = 'Subscription and Stripe payouts are fully set up.';
  connectMessage.className = 'message ok';
}

async function loadDashboard() {
  organizerStatus.textContent = 'Loading...';
  leaguesTable.innerHTML = '<tr><td colspan="6" class="muted">Loading...</td></tr>';

  try {
    const res = await fetch('/organizer/dashboard', {
      method: 'GET',
      credentials: 'include'
    });

    if (res.status === 401 || isHtmlResponse(res)) {
      redirectToLogin();
      return;
    }

    if (!res.ok) {
      throw new Error(await parseError(res));
    }

    const data = await res.json();
    const organizer = data.organizer || null;
    const leagues = Array.isArray(data.leagues) ? data.leagues : [];

    currentOrganizer = organizer;

    if (organizer) {
      organizerStatus.innerHTML = statusText(organizer);
      updateActionState(organizer);
    } else {
      organizerStatus.textContent = 'Organizer not found.';
      updateActionState(null);
    }

    if (leagues.length) {
      leaguesTable.innerHTML = leagues.map((l) => `
        <tr>
          <td>${l.id}</td>
          <td>${l.name}</td>
          <td>${l.slug}</td>
          <td>CAD ${centsToCadLabel(l.price)}</td>
          <td>${l.status}</td>
          <td>${l.organizer_name}</td>
        </tr>
      `).join('');
    } else {
      leaguesTable.innerHTML = '<tr><td colspan="6" class="muted">No leagues yet.</td></tr>';
    }
  } catch (err) {
    organizerStatus.innerHTML = `<span class="error">Error:</span> ${err.message}`;
    leaguesTable.innerHTML = '<tr><td colspan="6" class="error">Failed to load leagues.</td></tr>';
  }
}

refreshBtn.addEventListener('click', loadDashboard);

subscribeForm.addEventListener('submit', () => {
  subscribeBtn.disabled = true;
  subscribeBtn.textContent = 'Starting subscription...';
});

connectBtn.addEventListener('click', async () => {
  if (!currentOrganizer) {
    connectMessage.textContent = 'Organizer data is not loaded yet.';
    connectMessage.className = 'message error';
    return;
  }

  if (currentOrganizer.subscription_status !== 'active') {
    connectMessage.textContent = 'Activate your subscription before connecting Stripe payouts.';
    connectMessage.className = 'message error';
    return;
  }

  connectMessage.textContent = 'Starting Stripe Connect...';
  connectMessage.className = 'message muted';

  try {
    const res = await fetch('/organizer/connect/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({})
    });

    if (res.status === 401 || isHtmlResponse(res)) {
      redirectToLogin();
      return;
    }

    if (!res.ok) {
      throw new Error(await parseError(res));
    }

    const data = await res.json();

    if (!data.url) {
      throw new Error('Stripe onboarding link was not returned.');
    }

    window.location.href = data.url;
  } catch (err) {
    connectMessage.textContent = err.message;
    connectMessage.className = 'message error';
  }
});

leagueForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  leagueMessage.textContent = 'Creating league...';
  leagueMessage.className = 'message muted';

  try {
    if (!currentOrganizer) {
      throw new Error('Organizer not loaded.');
    }

    if (currentOrganizer.subscription_status !== 'active') {
      throw new Error('Activate your subscription before creating leagues.');
    }

    if (!currentOrganizer.onboarding_complete) {
      throw new Error('Connect Stripe payouts before creating leagues.');
    }

    const payload = {
      name: leagueNameInput.value.trim(),
      slug: leagueSlugInput.value.trim(),
      price: Math.round(Number(leaguePriceInput.value) * 100)
    };

    const res = await fetch('/organizer/leagues/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload)
    });

    if (res.status === 401 || isHtmlResponse(res)) {
      redirectToLogin();
      return;
    }

    if (!res.ok) {
      throw new Error(await parseError(res));
    }

    const data = await res.json();
    leagueMessage.textContent = `Created: ${data.league.name} (${data.league.slug})`;
    leagueMessage.className = 'message ok';
    leagueForm.reset();
    await loadDashboard();
  } catch (err) {
    leagueMessage.textContent = err.message;
    leagueMessage.className = 'message error';
  }
});

loadDashboard();