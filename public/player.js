document.addEventListener('DOMContentLoaded', () => {
  async function loadDashboard() {
    try {
      const res = await fetch('/player/dashboard-data', {
        method: 'GET',
        credentials: 'same-origin'
      });

      if (res.status === 401) {
        window.location.href = '/player/login';
        return;
      }

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data?.error || 'Failed to load dashboard');
      }

      const player = data.player;
      const regs = Array.isArray(data.registrations) ? data.registrations : [];

      const playerInfo = document.getElementById('playerInfo');
      playerInfo.innerHTML = `
        <p><strong>${player?.full_name || 'Player'}</strong></p>
        <p>${player?.email || ''}</p>
        <p>${player?.phone || ''}</p>
      `;

      const tableBody = document.getElementById('regsTable');
      if (!regs.length) {
        tableBody.innerHTML = '<tr><td class="center" colspan="4">No registrations yet.</td></tr>';
        return;
      }

      tableBody.innerHTML = regs.map((reg) => `
        <tr>
          <td>${reg.id}</td>
          <td>${reg.league_id || ''}</td>
          <td>CAD ${(Number(reg.amount || 0) / 100).toFixed(2)}</td>
          <td>${reg.payment_status || ''}</td>
        </tr>
      `).join('');
    } catch (err) {
      const playerInfo = document.getElementById('playerInfo');
      if (playerInfo) {
        playerInfo.innerHTML = `<p class="error">${err.message || 'Error loading dashboard.'}</p>`;
      }
    }
  }

  loadDashboard();
});
