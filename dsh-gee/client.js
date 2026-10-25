window.__ModuleLoader__.load({
  id: '@local/dsh-gee',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'gee';
    const POLL_MS = 2000;

    const CSS = `
      .gee-root { display:flex; height:100%; min-height:0; color: var(--dsw-alias-label-primary); }
      .gee-side { width:300px; flex:0 0 300px; display:flex; flex-direction:column; min-height:0;
                  border-right:1px solid var(--dsw-alias-border-l1); }
      .gee-section { display:flex; align-items:center; justify-content:space-between; gap:8px;
                     padding:10px 10px 6px; font-size:11px; letter-spacing:.4px; text-transform:uppercase;
                     color: var(--dsw-alias-label-secondary); }
      .gee-header { display:flex; align-items:center; gap:6px; padding:4px 8px 8px; }
      .gee-path { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                  font-size:11px; color: var(--dsw-alias-label-secondary); }
      .gee-btn { border:1px solid var(--dsw-alias-border-l1); background:transparent; color:var(--dsw-alias-label-secondary);
                 border-radius:5px; height:22px; min-width:22px; padding:0 6px; font-size:11px; cursor:pointer; }
      .gee-btn:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 8%, transparent);
                       color: var(--dsw-alias-label-primary); }
      .gee-btn:disabled { opacity:.35; cursor:default; }
      .gee-list { overflow:auto; min-height:0; padding:0 6px 8px; }
      .gee-row { display:flex; align-items:center; gap:6px; height:26px; padding:0 6px; border-radius:6px;
                 font-size:12px; white-space:nowrap; user-select:none; }
      .gee-row:hover { background: color-mix(in srgb, var(--dsw-alias-label-primary) 7%, transparent); }
      .gee-row.is-folder { cursor:pointer; }
      .gee-row.is-image { cursor:pointer; }
      .gee-name { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
      .gee-meta { font-size:10px; opacity:.45; }
      .gee-add { opacity:0; font-size:15px; line-height:1; padding:0 3px; border-radius:4px;
                 color: var(--dsw-alias-brand-primary); }
      .gee-row:hover .gee-add { opacity:.9; }
      .gee-chevron { width:12px; height:12px; flex:0 0 12px; opacity:.55; transition:transform .12s ease; }
      .gee-chevron.open { transform:rotate(90deg); }
      .gee-spacer { width:12px; flex:0 0 12px; }
      .gee-icon { width:14px; height:14px; flex:0 0 14px; opacity:.75; }
      .gee-empty { padding:8px; font-size:11px; color: var(--dsw-alias-label-secondary); }
      .gee-map-wrap { position:relative; flex:1; min-width:0; min-height:0; }
      .gee-map { position:absolute; inset:0; background: var(--dsw-alias-bg-layer-2); }
      .gee-overlay { position:absolute; inset:0; display:grid; place-items:center; font-size:12px;
                     color: var(--dsw-alias-label-secondary); pointer-events:none; }
      .gee-error { position:absolute; left:8px; right:8px; bottom:8px; padding:6px 8px; font-size:11px;
                   border-radius:6px; background:#a02828; color:#fff; }
      .gee-swatch { width:8px; height:8px; border-radius:999px; background:#2f8f5b; flex:0 0 8px; }
      .gee-slider { width:52px; }
    `;

    let leafletLoader;

    function loadLeaflet() {
      if (window.L) return Promise.resolve(window.L);
      if (leafletLoader) return leafletLoader;
      leafletLoader = new Promise((resolve, reject) => {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/gee/vendor/leaflet.css';
        document.head.appendChild(link);
        const script = document.createElement('script');
        script.src = '/gee/vendor/leaflet.js';
        script.async = true;
        script.onload = () => (window.L ? resolve(window.L) : reject(new Error('Leaflet did not expose window.L')));
        script.onerror = () => reject(new Error('Leaflet failed to load'));
        document.head.appendChild(script);
      });
      return leafletLoader;
    }

    async function jsonFetch(url) {
      const response = await fetch(url, { headers: { accept: 'application/json' } });
      if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
      return response.json();
    }

    function Chevron(props) {
      return h(
        'svg',
        { className: `gee-chevron${props.open ? ' open' : ''}`, viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { d: 'M4.5 2.5 8 6l-3.5 3.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      );
    }

    function AssetIcon(props) {
      const type = props.type;
      if (type === 'FOLDER') {
        return h(
          'svg',
          { className: 'gee-icon', viewBox: '0 0 16 16', 'aria-hidden': true },
          h('path', { d: 'M1.5 4.2c0-.6.5-1.1 1.1-1.1h3.1l1.3 1.4h6.3c.6 0 1.1.5 1.1 1.1v6.2c0 .6-.5 1.1-1.1 1.1H2.6c-.6 0-1.1-.5-1.1-1.1V4.2z', fill: 'currentColor', opacity: 0.5 }),
        );
      }
      if (type === 'TABLE') {
        return h(
          'svg',
          { className: 'gee-icon', viewBox: '0 0 16 16', 'aria-hidden': true },
          h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { d: 'M2 6.2h12M6.4 2.6v10.8', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.8 }),
        );
      }
      if (type === 'IMAGE') {
        return h(
          'svg',
          { className: 'gee-icon', viewBox: '0 0 16 16', 'aria-hidden': true },
          h('rect', { x: 2, y: 2.5, width: 12, height: 11, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.2 }),
          h('path', { d: 'M2.6 11.4 6 8.2l2.2 2 1.9-1.7 3.3 3', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1 }),
        );
      }
      return h('span', { className: 'gee-spacer' });
    }

    function GeePanel() {
      const [layers, setLayers] = React.useState([]);
      const [hidden, setHidden] = React.useState({});
      const [opacity, setOpacity] = React.useState({});
      const [root, setRoot] = React.useState('');
      const [children, setChildren] = React.useState({});
      const [open, setOpen] = React.useState({});
      const [busy, setBusy] = React.useState({});
      const [error, setError] = React.useState('');
      const [mapReady, setMapReady] = React.useState(false);

      const containerRef = React.useRef(null);
      const mapRef = React.useRef(null);
      const tilesRef = React.useRef(new Map());

      React.useEffect(() => {
        let alive = true;
        let timer = 0;
        const tick = async () => {
          try {
            const state = await jsonFetch('/gee/state');
            if (!alive) return;
            setLayers(state.layers || []);
          } catch (failure) {
            if (alive) setError(String(failure.message || failure));
          }
          if (alive) timer = window.setTimeout(tick, POLL_MS);
        };
        tick();
        return () => {
          alive = false;
          window.clearTimeout(timer);
        };
      }, []);

      React.useEffect(() => {
        let disposed = false;
        loadLeaflet()
          .then((L) => {
            if (disposed || !containerRef.current || mapRef.current) return;
            const map = L.map(containerRef.current, { zoomControl: true, attributionControl: true });
            map.setView([35.5, 108.5], 4);
            L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
              maxZoom: 18,
              opacity: 0.35,
              attribution: '&copy; OpenStreetMap',
            }).addTo(map);
            mapRef.current = map;
            const observer = new ResizeObserver(() => map.invalidateSize());
            observer.observe(containerRef.current);
            setMapReady(true);
          })
          .catch((failure) => setError(String(failure.message || failure)));
        return () => {
          disposed = true;
          if (mapRef.current) {
            mapRef.current.remove();
            mapRef.current = null;
          }
        };
      }, []);

      React.useEffect(() => {
        const map = mapRef.current;
        if (!map || !window.L) return;
        const seen = new Set();
        for (const layer of layers) {
          seen.add(layer.id);
          if (!tilesRef.current.has(layer.id)) {
            const tile = window.L.tileLayer(layer.url, {
              maxZoom: 20,
              opacity: opacity[layer.id] ?? 0.9,
              attribution: 'Earth Engine',
              crossOrigin: true,
            });
            tile.addTo(map);
            tilesRef.current.set(layer.id, tile);
          }
        }
        for (const [id, tile] of tilesRef.current) {
          if (seen.has(id)) continue;
          map.removeLayer(tile);
          tilesRef.current.delete(id);
        }
        for (const [id, tile] of tilesRef.current) {
          tile.setOpacity(hidden[id] ? 0 : opacity[id] ?? 0.9);
        }
      }, [layers, hidden, opacity]);

      const loadFolder = React.useCallback(async (path) => {
        setBusy((current) => ({ ...current, [path]: true }));
        try {
          const page = await jsonFetch(`/gee/assets${path ? `?path=${encodeURIComponent(path)}` : ''}`);
          setChildren((current) => ({ ...current, [path]: page.assets || [] }));
          if (!path) setRoot(page.parent || '');
          setError('');
        } catch (failure) {
          setError(String(failure.message || failure));
        } finally {
          setBusy((current) => {
            const next = { ...current };
            delete next[path];
            return next;
          });
        }
      }, []);

      React.useEffect(() => {
        loadFolder('');
      }, [loadFolder]);

      const toggle = (path) => {
        setOpen((current) => {
          const next = { ...current, [path]: !current[path] };
          return next;
        });
        if (!children[path] && !busy[path]) loadFolder(path);
      };

      const addAssetLayer = async (name) => {
        try {
          await jsonFetch(`/gee/asset-layer?name=${encodeURIComponent(name)}`);
          const state = await jsonFetch('/gee/state');
          setLayers(state.layers || []);
          setError('');
        } catch (failure) {
          setError(String(failure.message || failure));
        }
      };

      const removeLayer = async (id) => {
        try {
          const state = await jsonFetch(`/gee/layer/remove?id=${encodeURIComponent(id)}`);
          setLayers(state.layers || []);
        } catch (failure) {
          setError(String(failure.message || failure));
        }
      };

      const renderNode = (asset, depth) => {
        const segments = (asset.name || '').split('/');
        const label = segments[segments.length - 1] || asset.name;
        const isFolder = asset.type === 'FOLDER';
        const isOpen = Boolean(open[asset.name]);
        const kids = children[asset.name];
        const pending = busy[asset.name];
        const rows = [
          h(
            'div',
            {
              key: asset.name,
              className: `gee-row${isFolder ? ' is-folder' : asset.type === 'IMAGE' ? ' is-image' : ''}`,
              style: { paddingLeft: 6 + depth * 12 },
              onClick: () => (isFolder ? toggle(asset.name) : addAssetLayer(asset.name)),
              title: isFolder ? 'Expand folder' : 'Add as map layer',
            },
            isFolder ? h(Chevron, { open: isOpen }) : h('span', { className: 'gee-spacer' }),
            h(AssetIcon, { type: asset.type }),
            h('span', { className: 'gee-name' }, label),
            isFolder ? null : h('span', { className: 'gee-add' }, '+'),
          ),
        ];
        if (isFolder && isOpen) {
          if (pending && !kids) rows.push(h('div', { key: `${asset.name}:loading`, className: 'gee-empty', style: { paddingLeft: 28 + depth * 12 } }, 'Loading…'));
          else if (kids && kids.length === 0) rows.push(h('div', { key: `${asset.name}:empty`, className: 'gee-empty', style: { paddingLeft: 28 + depth * 12 } }, 'Empty folder'));
          else if (kids) rows.push(...kids.map((child) => renderNode(child, depth + 1)));
        }
        return rows;
      };

      const rootAssets = children[''] || [];

      return h(
        'div',
        { className: 'gee-root' },
        h('style', null, CSS),
        h(
          'div',
          { className: 'gee-side' },
          h(
            'div',
            { className: 'gee-section' },
            h('span', null, `Layers ${layers.length}`),
            layers.length > 0
              ? h('button', { className: 'gee-btn', onClick: () => Promise.all(layers.map((layer) => removeLayer(layer.id))) }, 'Clear')
              : null,
          ),
          h(
            'div',
            { className: 'gee-list', style: { maxHeight: '36%' } },
            layers.length === 0
              ? h('div', { className: 'gee-empty' }, 'No layers yet. Ask the agent, or click an image asset below.')
              : layers.map((layer) =>
                  h(
                    'div',
                    { key: layer.id, className: 'gee-row' },
                    h('input', {
                      type: 'checkbox',
                      checked: !hidden[layer.id],
                      onChange: () => setHidden((current) => ({ ...current, [layer.id]: !current[layer.id] })),
                      style: { cursor: 'pointer', margin: 0 },
                    }),
                    h('span', { className: 'gee-swatch', style: { background: layer.kind === 'asset' ? '#2f6f9f' : '#2f8f5b' } }),
                    h('span', { className: 'gee-name', title: layer.name }, layer.name),
                    h('input', {
                      className: 'gee-slider',
                      type: 'range',
                      min: 0,
                      max: 1,
                      step: 0.1,
                      value: opacity[layer.id] ?? 0.9,
                      onChange: (event) => setOpacity((current) => ({ ...current, [layer.id]: Number(event.target.value) })),
                    }),
                    h('button', { className: 'gee-btn', onClick: () => removeLayer(layer.id), title: 'Remove layer' }, '×'),
                  ),
                ),
          ),
          h('div', { className: 'gee-section' }, h('span', null, 'Assets')),
          h(
            'div',
            { className: 'gee-header' },
            h('span', { className: 'gee-path', title: root }, root || 'projects/…/assets'),
            h('button', { className: 'gee-btn', title: 'Reload', onClick: () => loadFolder(root) }, '⟳'),
          ),
          h(
            'div',
            { className: 'gee-list', style: { flex: 1 } },
            busy[''] && rootAssets.length === 0
              ? h('div', { className: 'gee-empty' }, 'Loading…')
              : rootAssets.length === 0
                ? h('div', { className: 'gee-empty' }, 'No assets.')
                : rootAssets.map((asset) => renderNode(asset, 0)),
          ),
        ),
        h(
          'div',
          { className: 'gee-map-wrap' },
          h('div', { className: 'gee-map', ref: containerRef }),
          !mapReady && !error ? h('div', { className: 'gee-overlay' }, 'Loading map…') : null,
          error ? h('div', { className: 'gee-error' }, error) : null,
        ),
      );
    }

    function GeeIcon(props) {
      const size = typeof (props && props.size) === 'number' ? props.size : 20;
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 12, cy: 12, r: 9.5, fill: '#2f8f5b' }),
        h('path', {
          d: 'M5.5 10.5c2.2-2.6 5-1.6 7.2.1 2 1.5 4 .4 5.2-1.2.6 3.2-1 6.4-3.9 8-3 1.6-6.8.6-8.4-2.4-.7-1.4-.7-3-.1-4.5z',
          fill: '#e8f6ee',
          opacity: 0.9,
        }),
        h('ellipse', { cx: 12, cy: 12, rx: 9.5, ry: 3.6, fill: 'none', stroke: '#1d6b43', strokeWidth: 1, transform: 'rotate(-18 12 12)' }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: 'GEE map' }, GeeIcon),
        );
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID }, GeePanel));
      },
    };
  },
});
