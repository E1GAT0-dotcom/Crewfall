// Entry point. Phase 1 step 1: proves the toolchain works. Step 3 replaces this
// with the real Phaser game bootstrap.
const root = document.getElementById('game');
if (root) {
  const p = document.createElement('p');
  p.style.color = '#cfd6e6';
  p.style.font = '20px system-ui, sans-serif';
  p.textContent = 'Crewfall toolchain OK. The ship arrives in step 3.';
  root.appendChild(p);
}
