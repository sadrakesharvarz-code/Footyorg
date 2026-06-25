
const organizerStatus = document.getElementById('organizerStatus');
const leaguesTable = document.getElementById('leaguesTable');
const refreshBtn = document.getElementById('refreshBtn');
const connectBtn = document.getElementById('connectBtn');
const connectMessage = document.getElementById('connectMessage');
const payoutStatus = document.getElementById('payoutStatus');
const leagueForm = document.getElementById('leagueForm');
const leagueMessage = document.getElementById('leagueMessage');
const leagueNameInput = document.getElementById('leagueName');
const leagueSlugInput = document.getElementById('leagueSlug');
const leaguePriceInput = document.getElementById('leaguePrice');

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

async function loadDashboard() {
  organizerStatus.textContent = 'Loading...';
  leaguesTable.innerHTML = '<tr><td colspan="6" class="muted">Loading...</td></tr>';

  try {
    const res = await fetch('/organizer/dashboard', {
      method: 'GET',
      credentials: 'same-origin'
    });

    if (res.status === 401) {
      redirectToLogin();
      return;
    }

    if (!res.ok) {
      throw new Error(await parseError(res));
    }

    const data = await res.json();
    const organizer = data.organizer || null;
    const leagues = Array.isArray(data.leagues) ? data.leagues : [];


    if (organizer) {
      organizerStatus.innerHTML = statusText(organizer);

      const ready =
        organizer.subscription_status === 'active' &&
        organizer.onboarding_complete;

      connectBtn.style.display = ready ? 'none' : 'inline-block';
      connectMessage.textContent = '';
      connectMessage.className = 'message';
      payoutStatus.style.display = ready ? 'block' : 'none';
    } else {
      organizerStatus.textContent = 'Organizer not found.';
      connectBtn.style.display = 'inline-block';
      payoutStatus.style.display = 'none';
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

connectBtn.addEventListener('click', async () => {
  connectMessage.textContent = 'Starting Stripe Connect...';
  connectMessage.className = 'message muted';

  try {
    const res = await fetch('/organizer/connect/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({})
    });

    if (res.status === 401) {
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
    const payload = {
      name: leagueNameInput.value.trim(),
      slug: leagueSlugInput.value.trim(),
      price: Math.round(Number(leaguePriceInput.value) * 100)
    };

    const res = await fetch('/organizer/leagues/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(payload)
    });

    if (res.status === 401) {
      redirectToLogin();
      return;
    }

    const text = await res.text();

    if (!res.ok) {
      throw new Error(text || 'Failed to create league.');
    }

    const data = JSON.parse(text);
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