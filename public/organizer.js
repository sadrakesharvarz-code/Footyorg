const organizerIdInput = document.getElementById('organizerId');
const organizerStatus = document.getElementById('organizerStatus');
const leaguesTable = document.getElementById('leaguesTable');
const refreshBtn = document.getElementById('refreshBtn');
const connectBtn = document.getElementById('connectBtn');
const connectMessage = document.getElementById('connectMessage');
const leagueForm = document.getElementById('leagueForm');
const leagueMessage = document.getElementById('leagueMessage');

function getOrganizerId() {
  return Number(organizerIdInput.value || 1);
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

async function loadDashboard() {
  const id = getOrganizerId();
  organizerStatus.textContent = 'Loading...';
  leaguesTable.innerHTML = '<tr><td colspan="6" class="muted">Loading...</td></tr>';

  try {
    const res = await fetch(`/organizer/dashboard?organizerId=${id}`);
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    const organizer = data.organizers.find(o => String(o.id) === String(id)) || data.organizers[0];

    if (organizer) {
      organizerStatus.innerHTML = statusText(organizer);
    } else {
      organizerStatus.textContent = 'Organizer not found.';
    }

    if (data.leagues.length) {
      leaguesTable.innerHTML = data.leagues.map(l => `
        <tr>
          <td>${l.id}</td>
          <td>${l.name}</td>
          <td>${l.slug}</td>
          <td>${l.price}</td>
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
      body: JSON.stringify({ organizerId: getOrganizerId() })
    });

    if (res.redirected) {
      window.location.href = res.url;
      return;
    }

    if (res.status === 303) {
      const location = res.headers.get('Location');
      if (location) {
        window.location.href = location;
        return;
      }
    }

    const text = await res.text();
    throw new Error(text);
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
      organizerId: getOrganizerId(),
      name: document.getElementById('leagueName').value.trim(),
      slug: document.getElementById('leagueSlug').value.trim(),
      price: Math.round(Number(document.getElementById('leaguePrice').value) * 100)
    };

    const res = await fetch('/organizer/leagues/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const text = await res.text();
    if (!res.ok) throw new Error(text);

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