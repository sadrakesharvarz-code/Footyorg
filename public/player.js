function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
  async function loadDashboard() {
    try {
      const res = await fetch('/player/dashboard-data', {
        method: 'GET',
        credentials: 'include'
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
      const teams = Array.isArray(data.teams) ? data.teams : [];

      const playerInfo = document.getElementById('playerInfo');
      playerInfo.innerHTML = `
        <p><strong>${player?.full_name || 'Player'}</strong></p>
        <p>${player?.email || ''}</p>
        <p>${player?.phone || ''}</p>
      `;

      const tableBody = document.getElementById('regsTable');
      if (!regs.length) {
        tableBody.innerHTML = '<tr><td class="center" colspan="4">No registrations yet.</td></tr>';
      } else {
        tableBody.innerHTML = regs.map((reg) => `
          <tr>
            <td>${reg.id}</td>
            <td>${reg.league_id || ''}</td>
            <td>CAD ${(Number(reg.amount || 0) / 100).toFixed(2)}</td>
            <td>${reg.payment_status || ''}</td>
          </tr>
        `).join('');
      }

      const teamsContainer = document.getElementById('playerTeams');
      if (!teams.length) {
        teamsContainer.innerHTML = '<p class="muted">No team assignments yet.</p>';
      } else {
        const groupedTeams = teams.reduce((acc, team) => {
          const key = `${team.league_db_id || ''}-${team.team_id || ''}`;
          if (!acc[key]) {
            acc[key] = {
              leagueName: team.league_name || team.league_slug || 'League',
              teamName: team.team_name || 'Team',
              players: []
            };
          }
          acc[key].players.push(team);
          return acc;
        }, {});

        teamsContainer.innerHTML = Object.values(groupedTeams).map((group) => `
          <div style="margin-bottom: 16px;">
            <h3 style="margin: 0 0 8px;">${escapeHtml(group.leagueName)} — ${escapeHtml(group.teamName)}</h3>
            <ul>
              ${group.players.map((player) => `
                <li><strong>${escapeHtml(player.full_name || player.email || 'Player')}</strong> — ${escapeHtml(player.position || 'Unassigned')}</li>
              `).join('')}
            </ul>
          </div>
        `).join('');
      }
    } catch (err) {
      const playerInfo = document.getElementById('playerInfo');
      if (playerInfo) {
        playerInfo.innerHTML = `<p class="error">${err.message || 'Error loading dashboard.'}</p>`;
      }
    }
  }

  loadDashboard();
});
