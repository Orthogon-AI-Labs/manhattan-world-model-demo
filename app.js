(function () {
  const payload = window.CODEX_SPEC_007_WORLD_MODEL_PAYLOAD;
  const leaflet = window.L;
  const app = document.getElementById("app");

  // spec-027 / phase-2a: when no dev-server backend is reachable (e.g. the
  // static GitHub Pages demo), the TARGETS overlay sources its weak-target
  // ranking directly from Supabase via the wm_weak_targets PostgREST RPC.
  // The publishable key is intentionally public; RLS makes it read-only.
  const WM_SUPABASE_URL = "https://luxnnmgayfknzmqxchdu.supabase.co";
  const WM_SUPABASE_PUBLISHABLE_KEY = "sb_publishable_h6Pw7xQVcj5kSndBx4BG4A_JHWQ2n2s";

  // spec-027 / phase-2c: discovery chips ("Best opportunities to pitch this
  // week", etc.) hit /api/discovery/query which runs Anthropic Haiku to
  // parse the natural-language question, then SQL on Supabase. There's no
  // pure-Postgres equivalent (Haiku is in the loop), so the static demo
  // calls a deployed copy of tools/dev-server.py on Fly.io instead.
  const WM_DEV_API_BASE = "https://orthogon-wm-api.fly.dev";

  // Shim that returns the legacy /api/buildings/weak-targets response
  // shape (so the rest of the file doesn't care where the data came from).
  // Tries the local dev-server first — if it's running the prototype keeps
  // its existing behavior. Falls back to Supabase RPC when the dev-server
  // is absent (the static demo case).
  function wmFetchWeakTargets(limit) {
    const localUrl = "/api/buildings/weak-targets?limit=" + (limit || 200);
    const supabaseUrl = WM_SUPABASE_URL + "/rest/v1/rpc/wm_weak_targets";

    function callSupabase() {
      return fetch(supabaseUrl, {
        method: "POST",
        headers: {
          "apikey": WM_SUPABASE_PUBLISHABLE_KEY,
          "Authorization": "Bearer " + WM_SUPABASE_PUBLISHABLE_KEY,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({ p_limit: limit || 200 })
      }).then(function (r) {
        if (!r.ok) return r.text().then(function (t) {
          throw new Error("supabase " + r.status + ": " + t.slice(0, 200));
        });
        return r.json();
      }).then(function (rows) {
        return {
          generated_at: new Date().toISOString(),
          generated_by: "supabase:wm_weak_targets",
          weakness_pool_size: rows.length,
          selection_limit: limit || 200,
          selection_pct: null,
          result_count: rows.length,
          weak_project_ids: rows.map(function (r) { return r.project_id; }),
          results: rows.map(function (r) {
            return {
              project_id: r.project_id,
              building_name: r.building_name,
              neighborhood: r.neighborhood,
              score: Number(r.score),
              dom_delta_days: r.dom_delta_days,
              // preserve the legacy key the rest of app.js reads
              avail_delta: Number(r.avail_ratio_delta),
              price_delta_pct: Number(r.price_delta_pct),
              weakness_one_liner: r.weakness_one_liner
            };
          })
        };
      });
    }

    // Try the local dev-server first; fall back to Supabase RPC on any
    // non-success (404, network error, etc.). This keeps the in-house
    // developer flow snappy while letting the static demo Just Work.
    return fetch(localUrl)
      .then(function (r) {
        if (!r.ok) throw new Error("dev-server " + r.status);
        return r.json();
      })
      .catch(callSupabase);
  }

  // spec-027 / phase-2c: wrap fetch("/api/discovery/query"). Same pattern
  // as wmFetchWeakTargets — try local dev-server first, fall through to
  // the deployed Fly.io copy on any non-OK / network error. The Fly host
  // mirrors the dev-server endpoint exactly, so the request + response
  // shapes are identical; no reshaping needed.
  function wmFetchDiscoveryQuery(body, init) {
    const localUrl = "/api/discovery/query";
    const remoteUrl = WM_DEV_API_BASE + "/api/discovery/query";
    const reqInit = Object.assign({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {})
    }, init || {});
    return fetch(localUrl, reqInit)
      .then(function (r) {
        if (!r.ok) throw new Error("dev-server " + r.status);
        return r;
      })
      .catch(function () { return fetch(remoteUrl, reqInit); });
  }

  // spec-027d: generic local-first / Fly-fallback for any /api/* path the
  // dev-server exposes. Per-building endpoints like /api/buildings/{id}/
  // performance + /performance/history flow through here so the static
  // demo's dossier shows real peer-comparison + weakness data. Returns
  // a Response so existing .then(r => r.json()) chains keep working.
  function wmFetchDevApi(path, init) {
    const remoteUrl = WM_DEV_API_BASE + path;
    return fetch(path, init)
      .then(function (r) {
        if (!r.ok) throw new Error("dev-server " + r.status);
        return r;
      })
      .catch(function () { return fetch(remoteUrl, init); });
  }

  if (!payload || !Array.isArray(payload.projects)) {
    app.textContent = "Payload unavailable.";
    return;
  }

  if (!leaflet) {
    app.textContent = "Map library unavailable.";
    return;
  }

  // UI-only mock overlay to showcase "add" vs "edit" affordances. Engineer replaces with real payload fields.
  const UI_MOCK = {
    "wm_proj_current_116_john": {
      street_easy_url: "https://streeteasy.com/building/116-john",
      decision_makers: [
        { name: "Dana Reyes", role: "VP Leasing", org: "Greystar", status: "primary", fub_id: "482311" },
        { name: "Marco Bell", role: "Asset Mgr", org: "Silverstein Properties", status: "secondary" }
      ]
    }
  };

  // In-memory overrides for inline-editable org fields (Owner / Manager / Broker).
  // Shape: { [project_id]: { owner: string, manager: string, broker: string } }
  // Persists for the page session only — real persistence lands when backend does.
  const ORG_OVERRIDES = {};
  function getOrgValue(projectId, role, fallback) {
    const o = ORG_OVERRIDES[projectId];
    if (o && typeof o[role] === "string") return o[role];
    return fallback;
  }
  function setOrgValue(projectId, role, value) {
    if (!ORG_OVERRIDES[projectId]) ORG_OVERRIDES[projectId] = {};
    ORG_OVERRIDES[projectId][role] = value;
  }

  // spec-023b: merge dev-buildings payload (156 pipeline rows from hermes_newdev)
  // alongside the BOND rentals. Dev rows render light-gray per design.md
  // (market_mode='future') and slot into existing filter pills cleanly.
  const devPayload = window.CODEX_SPEC_023_DEV_BUILDINGS_PAYLOAD;
  const allProjectRecords = payload.projects.concat(
    devPayload && Array.isArray(devPayload.projects) ? devPayload.projects : []
  );
  const projects = allProjectRecords.map(function (project) {
    const map = project.map_record || {};
    const list = project.list_record || {};
    const dossier = project.dossier_record || {};
    const facts = dossier.facts || {};
    const site = facts.primary_site || {};
    const workflow = dossier.workflow_target || {};
    const organizations = dossier.organizations || {};
    const contacts = Array.isArray(dossier.contacts) ? dossier.contacts : [];
    const listingAgents = Array.isArray(dossier.listing_agents) ? dossier.listing_agents : [];
    const latitude = Number(map.latitude || site.latitude || 0);
    const longitude = Number(map.longitude || site.longitude || 0);
    const stories = Number(
      map.stories_actual_or_estimated ||
      facts.stories_actual_or_estimated ||
      site.stories_actual_or_estimated ||
      1
    );
    const unitCount = Number(list.unit_count || facts.unit_count || 0);
    const priorityScore = Number(workflow.priority_score || 0);

    return {
      project_id: project.project_id,
      map: map,
      list: list,
      dossier: dossier,
      facts: facts,
      site: site,
      workflow: workflow,
      organizations: organizations,
      contacts: contacts,
      listingAgents: listingAgents,
      latitude: latitude,
      longitude: longitude,
      stories: Number.isFinite(stories) && stories > 0 ? stories : 1,
      units: Number.isFinite(unitCount) ? unitCount : 0,
      priorityScore: Number.isFinite(priorityScore) ? priorityScore : 0,
      hasCoordinates: Number.isFinite(latitude) && Number.isFinite(longitude) && latitude !== 0 && longitude !== 0,
      uiMock: UI_MOCK[project.project_id] || {}
    };
  });

  if (!projects.length) {
    app.textContent = "No projects available.";
    return;
  }

  const projectById = new Map(projects.map(function (project) {
    return [project.project_id, project];
  }));
  // spec-023p: defensive bbox filter — the corpus is Manhattan-only per
  // CLAUDE.md, so any project with lat/lng outside this rough bbox is
  // either a geocode error or junk data. Hide it from the map and warn
  // in the console listing the bad project_ids so we notice. Bbox is
  // generous (covers all of Manhattan + Roosevelt Island + nearby docks)
  // without leaking into Brooklyn / Staten Island / NJ.
  const MANHATTAN_BBOX_LAT = [40.68, 40.88];
  const MANHATTAN_BBOX_LNG = [-74.04, -73.91];
  function _withinManhattanBbox(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng)
      && lat >= MANHATTAN_BBOX_LAT[0] && lat <= MANHATTAN_BBOX_LAT[1]
      && lng >= MANHATTAN_BBOX_LNG[0] && lng <= MANHATTAN_BBOX_LNG[1];
  }
  const _bboxOutliers = projects.filter(function (p) {
    return p.hasCoordinates && !_withinManhattanBbox(p.latitude, p.longitude);
  });
  if (_bboxOutliers.length) {
    console.warn(
      "[spec-023p] " + _bboxOutliers.length + " building(s) have lat/lng outside the Manhattan bbox — hiding from the map. "
      + "Re-run world-model/transforms/doorman_to_payload.py to re-geocode. project_ids:",
      _bboxOutliers.map(function (p) { return p.project_id; })
    );
  }
  const mappableProjects = projects.filter(function (project) {
    return project.hasCoordinates && _withinManhattanBbox(project.latitude, project.longitude);
  });
  function buildProjectSearchBlob(project) {
    const facts = project.facts || {};
    const list = project.list || {};
    const map = project.map || {};
    const site = project.site || {};
    const orgs = project.organizations || {};
    function names(arr) {
      return (Array.isArray(arr) ? arr : []).map(function (o) {
        return typeof o === "string" ? o : (o && o.org_name) || "";
      }).filter(Boolean);
    }
    function agentNames(arr) {
      return (Array.isArray(arr) ? arr : []).map(function (a) { return (a && a.name) || ""; }).filter(Boolean);
    }
    function contactNames(arr) {
      return (Array.isArray(arr) ? arr : []).map(function (c) { return (c && c.name) || ""; }).filter(Boolean);
    }
    const parts = [
      facts.project_name, list.project_name, map.project_name,
      site.canonical_address, site.normalized_address, site.neighborhood,
      list.neighborhood, map.neighborhood, map.borough,
    ]
      .concat(names(orgs.sponsors))
      .concat(names(orgs.operators))
      .concat(names(orgs.marketers))
      .concat(agentNames(project.listingAgents))
      .concat(contactNames(project.contacts));
    // spec-023c: also index dev_facts so lens search finds dev buildings by
    // developer name, architect name, etc.
    const devFacts = (facts && facts.dev_facts) || {};
    const team = devFacts.team || {};
    const sources = devFacts.sources || {};
    const construction = devFacts.construction || {};
    parts.push(team.developer_org, team.architect_org, team.owner_org);
    parts.push(sources.source_excerpt, sources.source_site, sources.source_title);
    parts.push(construction.stage);
    return parts.filter(Boolean).join(" • ").toLowerCase();
  }
  let searchIndex = new Map(projects.map(function (project) {
    return [project.project_id, buildProjectSearchBlob(project)];
  }));
  function rebuildSearchIndex() {
    // Called after server-side mutations (e.g. spec-012 DM-promotion) so
    // newly-added contact names and project metadata become searchable.
    searchIndex = new Map(projects.map(function (project) {
      return [project.project_id, buildProjectSearchBlob(project)];
    }));
  }

  // ---- spec-012 DM promotion --------------------------------------------

  function mergeServerProject(serverProject) {
    // Server returns the canonical project envelope. Re-derive the
    // app's lighter project shape for the matching id and swap in place
    // so render pipelines pick up the new contacts / decision_maker_status
    // without a full payload reload.
    const idx = projects.findIndex(function (p) { return p.project_id === serverProject.project_id; });
    if (idx === -1) return null;
    const map = serverProject.map_record || {};
    const list = serverProject.list_record || {};
    const dossier = serverProject.dossier_record || {};
    const facts = dossier.facts || {};
    const site = facts.primary_site || {};
    const workflow = dossier.workflow_target || {};
    const organizations = dossier.organizations || {};
    const contacts = Array.isArray(dossier.contacts) ? dossier.contacts : [];
    const listingAgents = Array.isArray(dossier.listing_agents) ? dossier.listing_agents : [];
    const prev = projects[idx];
    const next = Object.assign({}, prev, {
      map: map,
      list: list,
      dossier: dossier,
      facts: facts,
      site: site,
      workflow: workflow,
      organizations: organizations,
      contacts: contacts,
      listingAgents: listingAgents,
    });
    projects[idx] = next;
    projectById.set(next.project_id, next);
    return next;
  }

  function openDmPromotionForm(project, prefill, anchor) {
    // Idempotent: if a form already lives below the anchor, focus and reuse.
    if (anchor && anchor._dmPromotionForm && anchor._dmPromotionForm.isConnected) {
      const f = anchor._dmPromotionForm.querySelector("input[name='name']");
      if (f) f.focus();
      return;
    }
    const editingContactId = (prefill && prefill.editingContactId) || null;
    const isEdit = Boolean(editingContactId);
    const form = createEl("div", "dm-promote-form");
    form.style.marginTop = "10px";
    form.style.padding = "12px 14px";
    form.style.background = "var(--paper)";
    form.style.border = "1px solid var(--line)";
    form.style.borderLeft = "2px solid var(--accent, #6f8096)";
    form.style.display = "flex";
    form.style.flexDirection = "column";
    form.style.gap = "8px";

    function field(label, name, value, type) {
      const wrap = createEl("label", "dm-promote-field");
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.gap = "3px";
      wrap.style.fontSize = "10.5px";
      wrap.style.color = "var(--ink-faint)";
      wrap.style.letterSpacing = "0.05em";
      wrap.style.textTransform = "uppercase";
      wrap.appendChild(document.createTextNode(label));
      const input = document.createElement("input");
      input.type = type || "text";
      input.name = name;
      input.value = value || "";
      input.className = "editable-input";
      input.style.textAlign = "left";
      input.style.fontSize = "12.5px";
      input.style.color = "var(--ink)";
      input.style.textTransform = "none";
      input.style.letterSpacing = "0";
      wrap.appendChild(input);
      return wrap;
    }

    const nameField = field("Name", "name", (prefill && prefill.name) || "");
    const phoneField = field("Phone", "phone", (prefill && prefill.phone) || "");
    const emailField = field("Email", "email", (prefill && prefill.email) || "", "email");
    form.appendChild(nameField);
    form.appendChild(phoneField);
    form.appendChild(emailField);

    // FUB-on-create checkbox is only meaningful for new promotions. In edit
    // mode, FUB sync is out of scope (FUB integration is write-only on
    // create per spec-011); keep the form focused on the local fields.
    const fubCheck = document.createElement("input");
    fubCheck.type = "checkbox";
    if (!isEdit) {
      const fubRow = createEl("label", "dm-promote-fub");
      fubRow.style.display = "flex";
      fubRow.style.alignItems = "center";
      fubRow.style.gap = "8px";
      fubRow.style.fontSize = "11.5px";
      fubRow.style.color = "var(--ink-faint)";
      fubCheck.title = "Create a matching Follow Up Boss person on submit (requires email)";
      fubRow.appendChild(fubCheck);
      fubRow.appendChild(document.createTextNode("Create in Follow Up Boss"));
      fubRow.appendChild(createEl("span", "dm-promote-fub-hint", " — requires email"));
      form.appendChild(fubRow);
    }

    const status = createEl("div", "dm-promote-status");
    status.style.fontSize = "11px";
    status.style.color = "var(--ink-faint)";
    status.style.minHeight = "14px";
    form.appendChild(status);

    const actions = createEl("div", "dm-promote-actions");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const cancel = createEl("button", "");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.padding = "6px 12px";
    cancel.style.background = "transparent";
    cancel.style.border = "1px solid var(--line)";
    cancel.style.cursor = "pointer";
    cancel.style.font = "inherit";
    cancel.style.fontSize = "11.5px";
    cancel.addEventListener("click", function () {
      closeForm();
    });
    actions.appendChild(cancel);

    const submit = createEl("button", "");
    submit.type = "button";
    submit.textContent = isEdit ? "Save" : "Promote";
    submit.style.padding = "6px 12px";
    submit.style.background = "var(--ink)";
    submit.style.color = "var(--paper)";
    submit.style.border = "1px solid var(--ink)";
    submit.style.cursor = "pointer";
    submit.style.font = "inherit";
    submit.style.fontSize = "11.5px";
    actions.appendChild(submit);
    form.appendChild(actions);

    function closeForm() {
      if (anchor) anchor._dmPromotionForm = null;
      form.remove();
    }

    submit.addEventListener("click", function () {
      const nameInput = form.querySelector("input[name='name']");
      const phoneInput = form.querySelector("input[name='phone']");
      const emailInput = form.querySelector("input[name='email']");
      const name = (nameInput.value || "").trim();
      const phone = (phoneInput.value || "").trim();
      const email = (emailInput.value || "").trim();
      const wantFub = !isEdit && !!fubCheck.checked;
      if (!name) {
        status.textContent = "Name is required.";
        status.style.color = "#7b4a38";
        nameInput.focus();
        return;
      }
      if (wantFub && !email) {
        status.textContent = "Email is required to create in Follow Up Boss.";
        status.style.color = "#7b4a38";
        emailInput.focus();
        return;
      }
      submit.disabled = true;
      cancel.disabled = true;
      status.style.color = "var(--ink-faint)";

      const op = isEdit
        ? updateDmPromotion(project.project_id, editingContactId, {name: name, phone: phone, email: email})
        : submitDmPromotion(project.project_id, {name: name, phone: phone, email: email, create_fub: wantFub});

      status.textContent = isEdit ? "Saving…" : (wantFub ? "Promoting + creating in FUB…" : "Promoting…");

      op.then(function (result) {
        const next = mergeServerProject(result.project);
        rebuildSearchIndex();
        if (next && next.project_id === selectedId) {
          renderAll();
          applyAllFilters();
        }
        if (result.fub_error) {
          submit.disabled = false;
          cancel.disabled = false;
          status.style.color = "#7b4a38";
          status.textContent = "Saved locally; FUB error: " + (result.fub_error.message || result.fub_error.code);
        }
        // On clean success (no fub_error), the dossier re-renders above, which
        // unmounts this form anchor — no explicit close needed.
      }).catch(function (err) {
        submit.disabled = false;
        cancel.disabled = false;
        status.style.color = "#7b4a38";
        status.textContent = "Failed: " + (err && err.message ? err.message : String(err));
      });
    });

    if (anchor) {
      anchor._dmPromotionForm = form;
      if (anchor.parentNode) {
        anchor.parentNode.insertBefore(form, anchor.nextSibling);
      } else {
        anchor.appendChild(form);
      }
    }
    setTimeout(function () { nameField.querySelector("input").focus(); }, 0);
  }

  function updateDmPromotion(projectId, contactId, body) {
    // PATCH /api/projects/{id}/dm-promotions/{contact_id}. Returns
    // {project: <envelope>}; non-2xx throws an Error with .status / .code.
    // Edits don't touch FUB — sync stays write-only on create per spec-011.
    const url = "/api/projects/" + encodeURIComponent(projectId)
      + "/dm-promotions/" + encodeURIComponent(contactId);
    // spec-027d + phase-2b: routed through wmFetchDevApi so the static
    // demo's "Edit DM" button hits the Fly backend, which now persists the
    // contact in Supabase wm_project.dossier_record.contacts.
    return wmFetchDevApi(url, {
      method: "PATCH",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    }).then(function (resp) {
      return resp.json().then(function (data) { return {resp: resp, data: data}; });
    }).then(function (out) {
      if (!out.resp.ok) {
        const msg = (out.data && out.data.error && out.data.error.message) || ("HTTP " + out.resp.status);
        const err = new Error(msg);
        err.status = out.resp.status;
        err.code = (out.data && out.data.error && out.data.error.code) || "unknown";
        throw err;
      }
      return {project: out.data};
    });
  }

  function submitDmPromotion(projectId, body) {
    // Returns {project, fub_error?}. 200 → {project: <envelope>}.
    // 207 multi-status (CODEX-SPEC-011) → {project, fub_error}. Non-2xx
    // throws an Error with .status and .code.
    const url = "/api/projects/" + encodeURIComponent(projectId) + "/dm-promotions";
    // spec-027d + phase-2b: routed through wmFetchDevApi; the Fly backend
    // persists promoted contacts in Supabase.
    return wmFetchDevApi(url, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(body),
    }).then(function (resp) {
      return resp.json().then(function (data) { return {resp: resp, data: data}; });
    }).then(function (out) {
      if (out.resp.status === 207) {
        return {project: out.data.project, fub_error: out.data.fub_error || null};
      }
      if (!out.resp.ok) {
        const msg = (out.data && out.data.error && out.data.error.message) || ("HTTP " + out.resp.status);
        const err = new Error(msg);
        err.status = out.resp.status;
        err.code = (out.data && out.data.error && out.data.error.code) || "unknown";
        throw err;
      }
      return {project: out.data};
    });
  }
  const storyExtent = extent(projects.map(function (project) {
    return project.stories;
  }));
  const markerById = new Map();
  const nodes = {};
  let map = null;
  let selectedId = projects[0].project_id;
  let hoveredId = null;
  let marketingFilter = "any"; // "any" | "in_house" | "outside_agent" | "unknown" | "not_marketed_yet"
  let dmFilter = "any"; // "any" | "known" | "unknown" — wired by spec-012 DM toggle
  // Per schema.html §6.1 — building status. Multi-select: empty Set = "any".
  // spec-023l: trimmed to the two states we actually classify buildings into
  // — standing (BOND rentals + delivered hermes) and under-construction
  // (the 130-row dev/pipeline layer). Permitted/proposed/demolished pills
  // were dead UI; nothing in the corpus carries those statuses today.
  const BUILDING_STATUS_OPTIONS = [
    { value: "standing-building", label: "Standing" },
    { value: "under-construction", label: "Under construction" },
  ];
  const BUILDING_STATUS_SHORT = {
    "standing-building": "Standing", "under-construction": "Under construction",
  };
  let buildingStatusSelected = new Set();
  // Per schema.html §6.3 — size buckets keyed off unit_count. Multi-select.
  const SIZE_OPTIONS = [
    { value: "xs", label: "XS · <50" },
    { value: "s", label: "S · 50–149" },
    { value: "m", label: "M · 150–299" },
    { value: "l", label: "L · 300–499" },
    { value: "xl", label: "XL · 500+" },
  ];
  const SIZE_SHORT = { xs: "XS", s: "S", m: "M", l: "L", xl: "XL" };
  let sizeSelected = new Set();
  // spec-023l: trimmed to the types our corpus actually carries — rental
  // (BOND + hermes-rental), condo (hermes-condo), and unknown (placeholder
  // for the 43 hermes rows with project_type='unknown' that aren't attached
  // yet, plus any future dev rows where hermes can't classify).
  // Co-op/mixed/affordable/student/senior pills were dead UI.
  const RESIDENTIAL_TYPE_OPTIONS = [
    { value: "rental", label: "Rental" },
    { value: "condo", label: "Condo" },
    { value: "unknown", label: "Unknown" },
  ];
  const RESIDENTIAL_TYPE_SHORT = {
    rental: "Rental", condo: "Condo", unknown: "Unknown",
  };
  let residentialTypeSelected = new Set();
  let searchFilter = "";
  let searchDebounceId = null;

  // spec-021: discovery box state — hoisted up here so buildShell() can
  // reference DISCOVERY_CHIPS / discoveryActive without temporal-dead-zone
  // errors (the `const` would otherwise be in TDZ when buildShell runs).
  //
  // The two "leasing slowest" chips are deliberately separate. The "now"
  // chip surfaces buildings whose CURRENT active listings have been sitting
  // unleased the longest — survivor metric, wide coverage. The "historically"
  // chip surfaces buildings whose LEASED listings took the longest from
  // first-active to closed-rented — actual flow signal, sparse for now
  // (~56 RENTED listings across 39 buildings) but populates as more weekly
  // crawls accumulate.
  const DISCOVERY_CHIPS = [
    "Best opportunities to pitch this week",
    "What's leasing slowest now",
    "What's leasing slowest historically",
    "Big inventory sitting unleased",
    // spec-023q: priced-LOW is a positive pitch signal (operator leaving
    // money on the table). Priced-HIGH chip explicitly NOT included —
    // brokers don't pitch on "your asking is too aggressive."
    "Buildings priced below peer median",
    // spec-023s: outside-rep prospecting chip. The other slow-lease /
    // inventory chips are structurally in-house-dominated (outside agents
    // are hired BECAUSE they lease faster + clear inventory). This chip
    // surfaces the outside-rep weak pool — which lives mostly in
    // priced-below + sub-threshold DOM signals — so a broker pitching to
    // pull an outside agent OFF a building has a list to work from.
    "Outside-rep buildings underperforming",
    "Hell's Kitchen 1BRs underperforming",
    // "Buildings priced way above peer median" deliberately removed —
    // price-above on its own isn't a pitchable signal (luxury buildings
    // can ask high and still lease). The signal is still parseable from
    // free-text queries ("buildings priced above peer"), it's just not
    // surfaced as a default chip.
    // spec-023i: pipeline-pitch chips. These short-circuit the rentals
    // discovery API and run client-side against payload-dev.js so brokers
    // can find dev-pipeline targets directly from the chip strip.
    "High permit velocity",
    "Near completion",
    "Newest finds",
    // spec-023k: stalled-project chip — projects with ETA in the past
    // that haven't moved into active-construction language. Surfaces
    // the projects sitting still while filings/sales are quiet.
    "Stalled projects",
  ];

  // spec-023i: chips that run locally on the dev-buildings (pipeline) layer
  // instead of POSTing to /api/discovery/query (which is rentals-only).
  const PIPELINE_CHIP_LABELS = new Set([
    "High permit velocity",
    "Near completion",
    "Newest finds",
    "Stalled projects",
  ]);

  // spec-023s: chips that run locally on rentals using a deeper-pool query
  // to /api/buildings/weak-targets, then client-side filter to a specific
  // marketing-mode bucket. The Haiku-parsed /api/discovery/query tops out
  // at limit=20 by signal strength — for outside-rep prospecting, the
  // top-20 is dominated by in-house buildings, so we pull a 200-deep pool
  // and slice client-side.
  const RENTAL_LOCAL_CHIP_LABELS = new Set([
    "Outside-rep buildings underperforming",
  ]);
  let discoveryActive = false;
  let discoveryResults = null;
  let discoveryError = null;
  // spec-023r: per-mode slicing on chip results. Default "both" = top 10
  // in-house + top 10 outside-agent so neither pool crowds out the other
  // (in-house dominates the raw weakness signal). User can flip to a
  // single mode to focus the list.
  let targetsMarketingFilter = "both";  // "both" | "in_house" | "outside_agent"
  // spec-025e: IDs currently rendered in the right-rail Targets list.
  // Used by getDiscoveryResultIdSet so the map lens narrows to whatever
  // is actually visible (chip slice OR fallback slice OR full chip
  // results) — refreshed every renderTargetsList call.
  let targetsActiveResultIds = null;
  const TARGETS_LIST_PER_MODE = 10;     // top N per mode for "both" view
  const TARGETS_LIST_LIMIT = 20;        // top N for single-mode views

  // spec-023j/m: targets overlay state. When `targetsOverlayActive` is true,
  // weak rentals get a bright-yellow highlight; non-weak markers are hidden.
  //
  // Backend returns up to 200 weak rentals ranked by weighted weakness score.
  // Frontend then slices the top N PER MARKETING MODE based on the current
  // left-rail marketing pill, so outside-agent targets aren't crowded out by
  // the much larger in-house set (35-of-top-38 was in-house pre-fix).
  //
  // - Any pill   → top 20 in_house + top 20 outside_agent (40 yellow markers)
  // - In-house   → top 20 in_house
  // - Outside    → top 20 outside_agent
  // - Unknown    → top 20 unknown
  let targetsOverlayActive = false;
  let weakTargetsRanked = null;   // Array<{project_id, score, ...}> | null
  let weakTargetLoading = false;
  let weakTargetIds = new Set();  // recomputed from weakTargetsRanked + marketing pill
  const TARGETS_PER_MODE = 20;

  function sizeBucket(unitCount) {
    const n = Number(unitCount);
    if (!Number.isFinite(n) || n <= 0) return null;
    if (n < 50) return "xs";
    if (n < 150) return "s";
    if (n < 300) return "m";
    if (n < 500) return "l";
    return "xl";
  }

  buildShell();
  initMap();
  renderAll();
  refreshLensSectionMeta();
  // Markers don't have DOM elements until after initial map render; defer one tick.
  setTimeout(applyMarketingFilter, 0);

  function getSelectedProject() {
    if (!selectedId) {
      return null;
    }

    return projectById.get(selectedId) || null;
  }

  function setSelected(projectId) {
    if (!projectId) {
      clearSelection();
      return;
    }

    if (selectedId === projectId) {
      return;
    }

    selectedId = projectId;
    renderAll();
    // spec-027f / phase-2b: fire-and-forget refresh of Supabase-backed
    // fields (marketing_mode, decision_maker_status). The dossier already
    // shows static-payload state instantly; this layers fresh state on
    // top within a few hundred ms.
    wmRefreshProjectFromSupabase(projectId);
  }

  // phase-2b: pull the latest /api/projects/{id} envelope from the
  // dev-server (Fly fallback handled by wmFetchDevApi) and merge the
  // editable fields into the in-memory project so the dossier reflects
  // any inline edits made elsewhere or via direct PATCH calls.
  function wmRefreshProjectFromSupabase(projectId) {
    if (!projectId) return;
    wmFetchDevApi("/api/projects/" + encodeURIComponent(projectId), {
      headers: { "Accept": "application/json" },
    })
      .then(function (r) { return r.ok ? r.json() : Promise.reject(r.status); })
      .then(function (freshProject) {
        const localProject = projectById.get(projectId);
        if (!localProject || !freshProject) return;
        // Apply the editable fields from the fresh envelope onto the
        // in-memory project shape. Reads use the same paths the
        // dossier render reads from.
        const freshDossier = freshProject.dossier_record || {};
        const freshFacts = freshDossier.facts || {};
        const freshWorkflow = freshDossier.workflow_target || {};
        let changed = false;
        if (freshFacts.marketing_mode !== undefined
            && localProject.facts.marketing_mode !== freshFacts.marketing_mode) {
          localProject.facts.marketing_mode = freshFacts.marketing_mode;
          changed = true;
        }
        if (freshWorkflow.decision_maker_status !== undefined
            && localProject.workflow.decision_maker_status !== freshWorkflow.decision_maker_status) {
          localProject.workflow.decision_maker_status = freshWorkflow.decision_maker_status;
          changed = true;
        }
        // Only re-render if the dossier is still showing this project
        // AND something actually changed (avoid render thrash).
        if (changed && selectedId === projectId) {
          renderDossier();
          // Lens count + marker color depend on these fields too.
          if (typeof applyAllFilters === "function") applyAllFilters();
        }
      })
      .catch(function (err) {
        // Quiet fail — if the backend is down, the static-payload state
        // is already on screen. No user-facing error needed.
        console.debug("[wm] project refresh failed for", projectId, err);
      });
  }

  function clearSelection() {
    if (!selectedId) {
      return;
    }

    selectedId = null;
    renderAll();
  }

  function setHovered(projectId) {
    if (hoveredId === projectId) {
      return;
    }

    hoveredId = projectId;
    renderList();
    updateMapState();
  }

  function extent(values) {
    let min = Infinity;
    let max = -Infinity;

    values.forEach(function (value) {
      if (Number.isFinite(value)) {
        min = Math.min(min, value);
        max = Math.max(max, value);
      }
    });

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      return [0, 1];
    }

    if (min === max) {
      return [min - 1, max + 1];
    }

    return [min, max];
  }

  function norm(value, min, max) {
    if (max === min) {
      return 0.5;
    }

    return (value - min) / (max - min);
  }

  function scaleStory(stories, isSelected) {
    const baseHeight = 24 + norm(stories, storyExtent[0], storyExtent[1]) * 42;
    return Math.round(baseHeight + (isSelected ? 6 : 0));
  }

  function text(value) {
    if (value === null || value === undefined || value === "") {
      return "—";
    }

    return String(value);
  }

  function orgNames(values) {
    if (!Array.isArray(values) || values.length === 0) {
      return "—";
    }

    return values.map(function (value) {
      return text(value && value.org_name);
    }).filter(function (value) {
      return value !== "—";
    }).join(", ") || "—";
  }

  function titleCaseToken(value) {
    return text(value)
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map(function (part) {
        return part.charAt(0).toUpperCase() + part.slice(1);
      })
      .join(" ");
  }

  function formatDate(value) {
    if (!value) {
      return "—";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return text(value);
    }

    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric"
    });
  }

  function daysFromGenerated(value) {
    if (!value || !payload.generated_at) {
      return null;
    }

    const target = new Date(value);
    const generated = new Date(payload.generated_at);

    if (Number.isNaN(target.getTime()) || Number.isNaN(generated.getTime())) {
      return null;
    }

    return Math.round((target.getTime() - generated.getTime()) / 86400000);
  }

  function buildTodayQueue(allProjects, limit) {
    const scored = [];
    allProjects.forEach(function (p) {
      const w = p.workflow || {};
      const delta = daysFromGenerated(w.next_action_due_at);
      const tier = String(p.list.target_tier || "").toUpperCase();
      const dm = String(w.decision_maker_status || "").toLowerCase();
      const reasons = [];
      let score = 0;

      if (delta !== null && delta <= 0) {
        score += 100 + Math.abs(delta);
        reasons.push({ label: delta === 0 ? "Due today" : (Math.abs(delta) + "d overdue"), tone: "alert" });
      }
      if (tier === "A") {
        score += 20;
        if (reasons.length === 0) reasons.push({ label: "A-tier", tone: "strong" });
      }
      if ((dm === "unknown" || !dm) && tier === "A") {
        score += 15;
        reasons.push({ label: "DM unknown", tone: "warm" });
      }
      const state = String(w.state || "").toLowerCase();
      if (state === "follow-up-due" || state === "stale") {
        score += 10;
        if (!reasons.some(function (r) { return /overdue|today/i.test(r.label); })) {
          reasons.push({ label: titleCaseToken(state), tone: "warm" });
        }
      }

      if (score > 0) scored.push({ project: p, score: score, reasons: reasons.slice(0, 3) });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 4);
  }

  function buildAgentSuggestions(allProjects) {
    const out = [];
    const tierAUnknownDm = allProjects.filter(function (p) {
      const t = String(p.list.target_tier || "").toUpperCase();
      const dm = String(p.workflow.decision_maker_status || "").toLowerCase();
      return t === "A" && (dm === "unknown" || !dm);
    });
    if (tierAUnknownDm.length >= 2) {
      out.push({
        text: tierAUnknownDm.length + " A-tier properties still missing a decision maker.",
        meta: "Batch research · est. 12 min"
      });
    }

    const staleIn = allProjects.filter(function (p) {
      const s = String(p.workflow.state || "").toLowerCase();
      const delta = daysFromGenerated(p.workflow.last_touched_at);
      return s === "in-discussion" && delta !== null && delta <= -30;
    });
    if (staleIn.length >= 1) {
      const one = staleIn[0];
      out.push({
        text: "Reopen " + text(one.facts.project_name || one.map.project_name) + " — in discussion 30+ days, no movement.",
        meta: "Draft re-engagement"
      });
    } else {
      const freshPitch = allProjects.filter(function (p) {
        return String(p.workflow.state || "").toLowerCase() === "needs-pitch";
      });
      if (freshPitch.length >= 1) {
        out.push({
          text: freshPitch.length + " buildings in Needs pitch — start with the closest A-tier.",
          meta: "Sort by distance"
        });
      }
    }

    const fubUnlinked = allProjects.filter(function (p) {
      return (!Array.isArray(p.contacts) || p.contacts.length === 0) && String(p.list.target_tier || "").toUpperCase() === "A";
    });
    if (fubUnlinked.length >= 2) {
      out.push({
        text: fubUnlinked.length + " A-tier contacts not yet in Follow Up Boss.",
        meta: "Sync selected"
      });
    }

    if (out.length === 0) {
      out.push({
        text: "Nothing urgent surfaced. Good time to prospect new pipeline sites.",
        meta: "Switch lens to Future"
      });
    }
    return out.slice(0, 3);
  }

  function formatDueBadge(value) {
    const delta = daysFromGenerated(value);

    if (delta === null) {
      return formatDate(value);
    }

    if (delta === 0) {
      return "Due today";
    }

    if (delta < 0) {
      return String(Math.abs(delta)) + "d overdue";
    }

    return "Due in " + String(delta) + "d";
  }

  function workflowTone(value) {
    const state = String(value || "").toLowerCase();

    if (state === "pitched" || state === "won") {
      return "is-success";
    }

    if (state === "follow-up-due" || state === "lost" || state === "stale") {
      return "is-alert";
    }

    if (state === "in-discussion") {
      return "is-active";
    }

    return "is-neutral";
  }

  function workflowLabel(value) {
    return titleCaseToken(value || "watch");
  }

  function tierLabel(value) {
    const tier = text(value || "C");
    const labels = {
      A: "A · Priority",
      B: "B · Qualified",
      C: "C · Watch"
    };

    return labels[tier] || "Tier " + tier;
  }

  function marketingStatus(project) {
    const mode = classifyLeasingMode(project);
    if (mode === "in_house") return { label: "In-house", tone: "is-lease-in-house" };
    if (mode === "outside_agent" || mode === "outside_broker") return { label: "Outside agent", tone: "is-lease-broker" };
    if (mode === "not_marketed_yet") return { label: "Not marketed yet", tone: "is-lease-not-marketed-yet" };
    return { label: "Unknown", tone: "is-lease-unknown" };
  }

  function decisionMakerStatus(workflow) {
    const status = String((workflow && workflow.decision_maker_status) || "unknown").toLowerCase();
    if (status === "known") return { label: "DM known", tone: "is-success" };
    return { label: "DM unknown", tone: "is-lease-unknown" };
  }

  function typeLabel(project) {
    const residentialType = String(project.facts.residential_type || project.list.residential_type || "").toLowerCase();
    const marketMode = String(project.facts.market_mode || project.list.market_mode || project.map.market_mode || "").toLowerCase();
    const canonicalStatus = titleCaseToken(project.facts.canonical_status || project.list.canonical_status || project.map.canonical_status);
    const typeText = residentialType === "condo"
      ? "Condo"
      : residentialType === "mixed"
        ? "Mixed · residential-led"
        : residentialType
          ? titleCaseToken(residentialType)
          : "Residential";
    const deliveryText = marketMode === "future" ? "Pipeline" : "Standing";

    return [typeText, deliveryText, canonicalStatus].join(" · ");
  }

  function typeLabelWithCompletion(project) {
    const base = typeLabel(project);
    const marketMode = String(project.facts.market_mode || project.list.market_mode || project.map.market_mode || "").toLowerCase();
    if (marketMode !== "future") return base;
    const f = project.facts || {};
    const d = project.dossier || {};
    const est = f.expected_completion || f.delivery_quarter || f.est_completion
      || d.expected_completion || d.delivery_quarter || d.est_completion
      || (project.list && (project.list.expected_completion || project.list.delivery_quarter));
    return est ? base + " · Est. " + String(est) : base + " · Est. completion TBD";
  }

  function priorityText(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0
      ? "P" + String(Number(value))
      : "P—";
  }

  function neutralText(value, fallback) {
    if (value === null || value === undefined || value === "") {
      return fallback || "—";
    }

    return String(value);
  }

  function parseRecordIds(value) {
    if (!value) {
      return [];
    }

    if (Array.isArray(value)) {
      return value;
    }

    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function createEl(tag, className, textValue) {
    const el = document.createElement(tag);

    if (className) {
      el.className = className;
    }

    if (textValue !== undefined) {
      el.textContent = textValue;
    }

    return el;
  }

  function buildShell() {
    app.innerHTML = "";

    const style = createEl("style");
    style.textContent = [
      /* v6.2 shell frame — header band + left rail + aperture + right rail */
      ".v62-shell{position:relative;min-height:100vh;background:var(--paper);}",
      ".v62-header{position:sticky;top:0;z-index:40;height:68px;background:var(--paper);border-bottom:1px solid var(--ink);display:grid;grid-template-columns:300px minmax(0,1fr) auto;align-items:stretch;}",
      ".v62-identity{padding:10px 24px;border-right:1px solid var(--line);display:flex;align-items:center;justify-content:center;min-width:0;}",
      ".v62-identity-logo{display:block;height:40px;width:auto;max-width:260px;}",
      ".v62-identity-kicker{display:flex;align-items:baseline;gap:10px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;margin-bottom:4px;}",
      ".v62-identity-kicker .rule{width:14px;height:1px;background:var(--line-strong);}",
      ".v62-identity-title{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:18px;font-weight:600;color:var(--ink);letter-spacing:-0.005em;line-height:1.05;}",
      ".v62-identity-title .slash{color:var(--ink-faint);font-weight:400;margin:0 6px;}",
      ".v62-identity-title .mode{color:#6f8096;}",
      ".v62-pulse{padding:0 24px;display:flex;align-items:center;gap:10px;flex-wrap:nowrap;min-width:0;overflow:hidden;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";}",
      ".v62-pulse-label{font-size:8.5px;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;white-space:nowrap;}",
      ".v62-pulse-total{font-size:18px;font-variant-numeric:tabular-nums;font-weight:600;color:var(--ink);line-height:1;}",
      ".v62-sep{width:1px;height:18px;background:var(--line);flex-shrink:0;}",
      ".v62-kpi{display:inline-flex;align-items:baseline;gap:5px;padding:3px 7px;border:1px solid transparent;background:transparent;white-space:nowrap;font-family:inherit;cursor:not-allowed;opacity:0.85;}",
      ".v62-kpi-label{font-size:8.5px;letter-spacing:0.2em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
      ".v62-kpi-value{font-size:12px;font-variant-numeric:tabular-nums;font-weight:500;color:var(--ink);line-height:1;}",
      ".v62-kpi.is-warm .v62-kpi-value{color:#7b4a38;}",
      ".v62-statechips{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;flex-shrink:0;}",
      ".v62-statechip{display:inline-flex;align-items:center;gap:4px;padding:2px 5px;border:1px solid transparent;background:transparent;font-family:inherit;cursor:not-allowed;opacity:0.85;}",
      ".v62-statechip .sw{width:7px;height:7px;border:0.5px solid rgba(20,20,18,0.4);}",
      ".v62-statechip .n{font-size:10px;font-variant-numeric:tabular-nums;font-weight:500;color:var(--ink);}",
      ".v62-mode{padding:10px 24px 10px 20px;border-left:1px solid var(--line);display:flex;align-items:center;gap:12px;}",
      ".v62-mode-label{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
      ".v62-mode-group{display:flex;border:1px solid var(--ink);background:var(--paper);height:28px;}",
      ".v62-mode-btn{padding:0 14px;border:none;background:transparent;color:var(--ink);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:500;height:100%;cursor:pointer;}",
      ".v62-mode-btn.is-active{background:var(--ink);color:var(--paper);font-weight:600;}",
      ".v62-mode-btn.is-disabled{color:var(--ink-faint);opacity:0.55;cursor:not-allowed;}",
      /* v6.2 body split */
      ".v62-body{position:relative;display:grid;grid-template-columns:300px minmax(0,1fr) 460px;align-items:stretch;min-height:calc(100vh - 68px);}",
      ".v62-lens{border-right:1px solid var(--ink);background:var(--paper);display:flex;flex-direction:column;min-height:calc(100vh - 68px);}",
      ".v62-lens-head{padding:16px 22px 14px;border-bottom:1px solid var(--ink);flex-shrink:0;}",
      ".v62-lens-head-row{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;}",
      ".v62-lens-kicker{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
      ".v62-lens-count{margin-top:3px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:13px;color:var(--ink);}",
      ".v62-lens-count .big{color:#6f8096;font-weight:700;font-variant-numeric:tabular-nums;font-size:20px;}",
      ".v62-lens-count .of{color:var(--ink-faint);margin-left:6px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;}",
      ".v62-lens-reset{padding:5px 9px;background:transparent;color:var(--ink-faint);border:1px solid var(--line);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;white-space:nowrap;cursor:not-allowed;}",
      ".v62-lens-search{display:flex;align-items:center;gap:8px;border:1px solid var(--line-strong);padding:6px 9px;background:var(--paper);opacity:0.75;}",
      ".v62-lens-search input{border:none;outline:none;background:transparent;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:12px;color:var(--ink-soft);flex:1;}",
      ".v62-lens-body{flex:1;overflow-y:auto;padding:14px 22px 16px;}",
      ".v62-flagblock{padding:10px 12px;border:1px solid var(--line);background:rgba(255,255,255,0.35);margin-bottom:18px;}",
      ".v62-flagblock-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:10px;}",
      ".v62-flagblock-title{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.28em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
      ".v62-quick{margin-bottom:9px;}",
      ".v62-quick-label{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:5px;font-weight:500;}",
      ".v62-quick-seg{display:flex;border:1px solid var(--line-strong);}",
      ".v62-quick-seg button{flex:1;padding:5px 0;border:none;background:var(--paper);color:var(--ink-soft);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;letter-spacing:0.08em;cursor:not-allowed;}",
      ".v62-quick-seg button.is-active{background:var(--ink);color:var(--paper);font-weight:600;}",
      ".v62-quick-seg button + button{border-left:1px solid var(--line-strong);}",
      ".v62-quick-check{display:flex;align-items:center;gap:10px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11px;color:var(--ink-soft);padding-top:2px;cursor:not-allowed;}",
      ".v62-quick-check .box{width:13px;height:13px;border-radius:2px;border:1px solid var(--line-strong);background:transparent;flex-shrink:0;}",
      ".v62-group-header{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:8.5px;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-faint);font-weight:700;margin-top:18px;margin-bottom:2px;padding-bottom:5px;border-bottom:1px solid var(--line-strong);}",
      ".v62-group-header:first-child{margin-top:0;}",
      ".v62-lens-section{border-bottom:1px solid var(--line);position:relative;}",
      ".v62-lens-section-row{width:100%;padding:10px 0;display:flex;align-items:center;gap:8px;}",
      ".v62-lens-section-btn{flex:1;background:transparent;border:none;padding:0;display:flex;justify-content:space-between;align-items:center;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";color:var(--ink-soft);cursor:not-allowed;}",
      ".v62-lens-section-btn:not(:disabled){cursor:pointer;}",
      ".v62-lens-section-btn:not(:disabled):hover .v62-lens-section-label{color:var(--ink);}",
      ".v62-lens-section-btn.is-open .v62-lens-section-meta .caret{transform:rotate(90deg);}",
      ".v62-lens-section-label{font-size:12px;letter-spacing:0.01em;font-weight:500;}",
      ".v62-lens-section-meta{font-size:10px;color:var(--ink-faint);letter-spacing:0.06em;font-variant-numeric:tabular-nums;display:inline-flex;align-items:center;gap:6px;}",
      ".v62-lens-section-meta .caret{color:var(--ink-faint);font-size:12px;transition:transform 140ms ease;}",
      ".lens-popdown{position:absolute;top:100%;left:0;right:0;margin-top:2px;background:var(--paper);border:1px solid var(--line-strong);box-shadow:0 4px 14px rgba(20,20,18,0.08);z-index:1000;padding:6px 0;display:flex;flex-direction:column;}",
      ".lens-popdown-row{display:flex;align-items:center;gap:9px;padding:6px 12px;cursor:pointer;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-size:12px;color:var(--ink);}",
      ".lens-popdown-row:hover{background:rgba(20,20,18,0.05);}",
      ".lens-popdown-row input[type=checkbox]{margin:0;cursor:pointer;accent-color:var(--ink);}",
      ".lens-popdown-row-label{flex:1;}",
      ".lens-popdown-clear{margin-top:4px;border:none;border-top:1px solid var(--line);background:transparent;padding:8px 12px;text-align:left;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-faint);cursor:pointer;}",
      ".lens-popdown-clear:hover{color:var(--ink);background:rgba(20,20,18,0.04);}",
      ".v62-lens-footer{padding:12px 22px 16px;border-top:1px solid var(--line);flex-shrink:0;background:var(--paper);}",
      ".v62-lens-export{width:100%;padding:10px 12px;background:var(--ink);color:var(--paper);border:1px solid var(--ink);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;display:flex;justify-content:space-between;align-items:center;cursor:not-allowed;opacity:0.65;border-style:dashed;}",
      /* spec-021: discovery bar — frosted-glass treatment so it reads as
         a distinct floating surface regardless of what's behind it.
         The previous warm-cream backgrounds visually merged with both
         the BOND header above (--paper) and the map's tan land tones
         below — they were all in the same color family. White-with-
         blur breaks out of that family entirely. Chips get their own
         opaque fill so they read as pills, not bare text, even when
         the bar's background fails behind them. */
      // spec-023p: z-index bumped 35 → 800 so the chip strip stays above
      // Leaflet's marker/tooltip/popup panes (default z-index 600/650/700).
      // Previously chips faded behind map content during pan/zoom.
      ".v62-discovery{position:sticky;top:68px;z-index:800;background:rgba(255,255,255,0.82);backdrop-filter:blur(14px) saturate(140%);-webkit-backdrop-filter:blur(14px) saturate(140%);border-bottom:1px solid var(--line-strong);padding:10px 18px;display:flex;align-items:center;gap:14px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;box-shadow:0 6px 16px rgba(25,25,23,0.06);}",
      ".v62-discovery-input-wrap{flex:0 0 auto;display:flex;align-items:center;gap:6px;padding:6px 12px;background:#ffffff;border:1px solid var(--line);border-radius:999px;width:380px;}",
      ".v62-discovery-input-wrap:focus-within{border-color:var(--ink-soft);}",
      ".v62-discovery-input{flex:1;border:none;outline:none;background:transparent;font-size:12px;color:var(--ink);}",
      ".v62-discovery-input::placeholder{color:var(--ink-faint);}",
      ".v62-discovery-clear{border:none;background:transparent;color:var(--ink-faint);cursor:pointer;font-size:14px;padding:0 4px;line-height:1;}",
      ".v62-discovery-clear:hover{color:var(--ink);}",
      ".v62-discovery-chips{display:flex;flex-wrap:nowrap;gap:6px;overflow-x:auto;flex:1;scrollbar-width:none;}",
      ".v62-discovery-chips::-webkit-scrollbar{display:none;}",
      ".v62-discovery-chip{flex:0 0 auto;padding:5px 12px;border:1px solid var(--line);background:#ffffff;border-radius:999px;font-size:11px;color:var(--ink-soft);cursor:pointer;white-space:nowrap;font-family:inherit;}",
      ".v62-discovery-chip:hover{border-color:var(--ink-soft);color:var(--ink);background:var(--paper);}",
      ".v62-discovery-status{flex:0 0 auto;font-size:10px;color:var(--ink-faint);letter-spacing:0.08em;text-transform:uppercase;}",
      /* spec-021: targets list rendered into the dossier rail when active */
      ".v62-targets-head{padding:14px 18px 10px;border-bottom:1px solid var(--line);}",
      ".v62-targets-title{font-size:11px;letter-spacing:0.12em;text-transform:uppercase;color:var(--ink-soft);}",
      ".v62-targets-subtitle{font-size:11px;color:var(--ink-faint);margin-top:4px;font-style:italic;}",
      ".v62-targets-list{padding:0;}",
      // spec-023r: in-house / outside / both toggle on chip results.
      ".v62-targets-toggle{display:flex;gap:0;margin-top:10px;border:1px solid var(--ink);background:var(--paper);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";height:24px;width:fit-content;}",
      ".v62-targets-toggle-btn{padding:0 12px;border:none;background:transparent;color:var(--ink);font-size:9.5px;letter-spacing:0.16em;text-transform:uppercase;font-weight:500;height:100%;cursor:pointer;}",
      ".v62-targets-toggle-btn.is-active{background:var(--ink);color:var(--paper);font-weight:600;}",
      ".v62-targets-toggle-btn:not(.is-active):hover{background:rgba(20,20,18,0.04);}",
      ".v62-target-row{padding:12px 18px;border-bottom:1px solid var(--line);cursor:pointer;background:transparent;border-left:0;border-right:0;border-top:0;text-align:left;width:100%;font-family:inherit;color:inherit;display:block;}",
      ".v62-target-row:hover{background:rgba(20,20,18,0.04);}",
      ".v62-target-name{font-size:14px;color:var(--ink);font-weight:500;}",
      ".v62-target-nb{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-size:10px;letter-spacing:0.06em;text-transform:uppercase;color:var(--ink-faint);margin-top:2px;}",
      ".v62-target-punchy{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-size:12px;color:var(--ink-soft);margin-top:6px;line-height:1.4;}",
      ".v62-target-punchy.is-extreme{color:var(--ink);font-weight:500;}",
      ".v62-targets-empty{padding:24px 18px;font-size:12px;color:var(--ink-soft);font-style:italic;}",
      ".v62-targets-error{padding:24px 18px;font-size:12px;color:var(--ink);border-left:3px solid #c8a960;background:rgba(200,169,96,0.08);font-style:italic;}",
      /* aperture — height accounts for the 68px main header AND the
         52px discovery sub-header (spec-021) so the map fits the
         viewport without overflow. */
      ".v62-aperture{position:relative;min-height:calc(100vh - 120px);overflow:hidden;background:transparent;}",
      /* override old shell */
      ".shell{display:grid;grid-template-columns:300px minmax(420px,1fr) 460px;min-height:100vh;gap:0;border-top:1px solid var(--line);}",
      ".rail,.dossier{padding:22px 18px 18px;background:var(--panel);backdrop-filter:blur(16px);}",
      ".rail{border-right:1px solid var(--line);}",
      ".dossier{border-left:1px solid var(--line);}",
      ".world{position:relative;padding:22px 18px 18px;overflow:hidden;}",
      ".world::before{content:'';position:absolute;inset:18px;background:linear-gradient(180deg, rgba(255,255,255,0.36), rgba(255,255,255,0.08));border:1px solid var(--line);box-shadow:var(--shadow);pointer-events:none;}",
      ".eyebrow{font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.26em;text-transform:uppercase;color:var(--ink-faint);margin-bottom:8px;}",
      ".title{font-size:29px;line-height:1.05;margin:0 0 8px;font-weight:normal;}",
      ".deck{font-family:Arial,sans-serif;font-size:12px;line-height:1.5;color:var(--ink-soft);max-width:30rem;}",
      ".list{margin-top:18px;border-top:1px solid var(--line);}",
      ".project-row{display:grid;grid-template-columns:1fr auto;gap:10px;padding:13px 0;border-bottom:1px solid var(--line);cursor:pointer;transition:opacity 140ms ease,color 140ms ease;outline:none;}",
      ".project-row:hover{opacity:1;}",
      ".project-row:focus-visible{box-shadow:inset 0 0 0 1px rgba(111,128,150,0.45);}",
      ".project-row.is-dim{opacity:0.5;}",
      ".project-row.is-selected{opacity:1;color:var(--selection);}",
      ".row-name{font-size:17px;line-height:1.15;margin-bottom:5px;}",
      ".row-meta,.row-status,.micro{font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.04em;line-height:1.45;color:var(--ink-soft);text-transform:uppercase;}",
      ".row-stack{text-align:right;}",
      ".world-inner{position:relative;z-index:1;height:calc(100vh - 40px);min-height:680px;display:flex;flex-direction:column;}",
      ".world-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:4px 10px 18px 10px;}",
      ".stats{display:flex;gap:18px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-soft);}",
      ".viewport{flex:1;position:relative;border-top:1px solid var(--line);overflow:hidden;}",
      ".map-canvas{position:absolute;inset:0;background:rgba(255,255,255,0.22);}",
      ".map-canvas .leaflet-pane,.map-canvas .leaflet-control{transition:opacity 140ms ease;}",
      ".map-canvas .leaflet-tile-pane{filter:grayscale(1) saturate(0.38) brightness(1.05) contrast(0.94);opacity:0.78;}",
      ".map-canvas .leaflet-control-container{font-family:Arial,sans-serif;}",
      ".map-canvas .leaflet-control-zoom{border:1px solid rgba(25,25,23,0.2);border-radius:0;box-shadow:var(--shadow);overflow:hidden;}",
      ".map-canvas .leaflet-control-zoom a{width:30px;height:30px;line-height:30px;background:rgba(252,251,248,0.92);color:var(--ink-soft);border-bottom:1px solid var(--line);}",
      ".map-canvas .leaflet-control-zoom a:last-child{border-bottom:none;}",
      ".map-canvas .leaflet-control-zoom a:hover{background:rgba(248,245,239,0.96);color:var(--ink);}",
      ".map-canvas .leaflet-control-attribution{background:rgba(252,251,248,0.84);color:var(--ink-faint);padding:4px 6px;border-top:1px solid var(--line);border-left:1px solid var(--line);}",
      ".map-canvas .leaflet-control-attribution a{color:inherit;}",
      ".map-wash{position:absolute;inset:0;background:linear-gradient(180deg, rgba(247,244,238,0.34), rgba(243,239,232,0.16));pointer-events:none;z-index:250;}",
      ".legend{position:absolute;left:10px;bottom:12px;display:flex;gap:18px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:0.05em;text-transform:uppercase;color:var(--ink-soft);z-index:700;background:rgba(252,251,248,0.9);padding:6px 10px;border:1px solid var(--line);}",
      ".legend-item{display:inline-flex;align-items:center;}",
      ".legend-item::before{content:'';display:inline-block;width:14px;height:10px;margin-right:8px;border:1.1px solid rgba(20,20,18,0.82);background:rgba(252,251,248,0.22);}",
      ".legend-item.is-lease-in-house::before{border-color:#4E6148;background:rgba(95,110,90,0.22);}",
      ".legend-item.is-lease-outside-broker::before{border-color:#9A6648;background:rgba(183,126,94,0.22);}",
      ".legend-item.is-lease-unknown::before{border-style:dashed;background:rgba(252,251,248,0.22);}",
".map-legend{position:fixed;left:314px;bottom:24px;z-index:700;background:#fcfbf8;border:1.2px solid var(--ink);box-shadow:0 10px 28px rgba(20,20,18,0.22),0 2px 6px rgba(20,20,18,0.14);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";max-width:260px;}",
// spec-025g: recenter pill — same bottom-anchor row as the Legend, sits
// to its right. Mirrors map-legend-head styling for visual consistency.
".map-recenter{position:fixed;left:438px;bottom:24px;z-index:700;display:flex;align-items:center;gap:7px;padding:9px 12px;background:var(--ink);color:#fcfbf8;border:1.2px solid var(--ink);box-shadow:0 10px 28px rgba(20,20,18,0.22),0 2px 6px rgba(20,20,18,0.14);cursor:pointer;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10.5px;letter-spacing:0.24em;text-transform:uppercase;font-weight:600;}",
".map-recenter:hover{background:#000;}",
".map-recenter-glyph{color:#fcfbf8;opacity:0.72;font-size:13px;line-height:1;}",
".map-recenter-label{color:inherit;}",
".map-legend-head{display:flex;align-items:center;gap:7px;width:100%;padding:9px 12px;background:var(--ink);color:#fcfbf8;border:none;cursor:pointer;font:inherit;font-size:10.5px;letter-spacing:0.24em;text-transform:uppercase;font-weight:600;}",
".map-legend-head:hover{background:#000;}",
".map-legend-glyph{color:#fcfbf8;opacity:0.72;}",
".map-legend-label{flex:1;text-align:left;}",
".map-legend-caret{color:#fcfbf8;opacity:0.72;transition:transform 140ms ease;}",
".map-legend.is-open .map-legend-caret{transform:rotate(90deg);}",
".map-legend-body{display:none;padding:8px 12px 12px;border-top:1px solid var(--line);max-height:360px;overflow-y:auto;}",
".map-legend.is-open .map-legend-body{display:block;}",
".map-legend-group{margin-top:10px;}",
".map-legend-group:first-child{margin-top:0;}",
".map-legend-group-title{font-size:8.5px;letter-spacing:0.24em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;margin-bottom:6px;}",
".map-legend-row{display:flex;align-items:center;gap:8px;padding:3px 0;}",
".map-legend-sw{display:inline-block;width:14px;height:10px;border:1.1px solid rgba(20,20,18,0.82);background:rgba(252,251,248,0.22);flex-shrink:0;}",
".map-legend-sw.is-lease-in-house{border-color:#4E6148;background:#5F6E5A;}",
".map-legend-sw.is-lease-outside-broker{border-color:#9A6648;background:#B77E5E;}",
".map-legend-sw.is-lease-unknown{border-style:dashed;background:rgba(252,251,248,0.22);}",
".map-legend-sw.is-rank-a{height:14px;background:var(--ink);border-color:var(--ink);}",
".map-legend-sw.is-rank-b{height:10px;background:rgba(20,20,18,0.55);border-color:rgba(20,20,18,0.55);}",
".map-legend-sw.is-rank-c{height:6px;background:rgba(20,20,18,0.3);border-color:rgba(20,20,18,0.3);}",
".map-legend-sw.is-state-pitched{background:#3d5c48;border-color:#2e4738;}",
".map-legend-sw.is-state-discussion{background:#6f8096;border-color:#506174;}",
".map-legend-sw.is-state-pitch{background:#b77e5e;border-color:#804F35;}",
".map-legend-sw.is-state-alert{background:#7b4a38;border-color:#5b3326;}",
".map-legend-text{font-size:11px;color:var(--ink-soft);letter-spacing:0;text-transform:none;font-weight:400;line-height:1.35;}",
".map-timeline{position:fixed;bottom:14px;z-index:700;background:transparent;border:none;box-shadow:none;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";padding:0;width:clamp(360px, 38vw, 480px);pointer-events:none;}",
".map-timeline-head{display:flex;align-items:baseline;justify-content:center;gap:8px;margin-bottom:4px;text-shadow:0 0 4px #fcfbf8,0 0 4px #fcfbf8,0 0 8px #fcfbf8;}",
".map-timeline-kicker{font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
".map-timeline-value{font-size:11.5px;font-weight:600;color:var(--ink);letter-spacing:0;font-feature-settings:\"tnum\",\"ss01\";}",
".map-timeline-value .tl-hint{display:none;}",
".map-timeline-track{position:relative;height:22px;margin:0 2px;pointer-events:auto;}",
".map-timeline-rail{position:absolute;left:0;right:0;top:10px;height:1.5px;background:rgba(20,20,18,0.28);box-shadow:0 0 0 2px rgba(252,251,248,0.7);}",
".map-timeline-fill{position:absolute;left:0;top:10px;height:1.5px;background:var(--ink);}",
".map-timeline-ticks{position:absolute;left:0;right:0;top:5px;height:11px;pointer-events:none;}",
".map-timeline-tick{display:none;}",
".map-timeline-tick.is-year{display:block;position:absolute;top:0;width:1px;height:11px;background:var(--ink);box-shadow:0 0 0 1.5px rgba(252,251,248,0.8);}",
".map-timeline-input{-webkit-appearance:none;appearance:none;position:absolute;left:0;right:0;top:0;width:100%;height:22px;background:transparent;margin:0;padding:0;outline:none;cursor:pointer;}",
".map-timeline-input::-webkit-slider-runnable-track{height:22px;background:transparent;border:none;}",
".map-timeline-input::-moz-range-track{height:22px;background:transparent;border:none;}",
".map-timeline-input::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:11px;height:18px;background:var(--ink);border:1.5px solid var(--ink);border-radius:1px;cursor:grab;margin-top:2px;box-shadow:0 0 0 2px rgba(252,251,248,0.85),0 1px 3px rgba(20,20,18,0.3);}",
".map-timeline-input::-moz-range-thumb{width:11px;height:18px;background:var(--ink);border:1.5px solid var(--ink);border-radius:1px;cursor:grab;box-shadow:0 0 0 2px rgba(252,251,248,0.85),0 1px 3px rgba(20,20,18,0.3);}",
".map-timeline-input:active::-webkit-slider-thumb{cursor:grabbing;}",
".map-timeline-input:focus-visible::-webkit-slider-thumb{outline:2px solid var(--accent);outline-offset:2px;}",
".map-timeline-scale{display:flex;justify-content:space-between;margin-top:2px;font-size:8.5px;letter-spacing:0.16em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;font-feature-settings:\"tnum\";text-shadow:0 0 3px #fcfbf8,0 0 3px #fcfbf8;}",
".map-timeline-caption{display:none;}",
".map-timeline-caption b{color:var(--ink-soft);font-weight:600;}",
".project-marker.is-tl-hidden{display:none !important;}",
".project-marker.is-mk-hidden{display:none !important;}",
".project-marker-icon.is-mk-hidden-outer{display:none !important;pointer-events:none !important;}",
".v62-quick-seg button:not(:disabled){cursor:pointer;}",
".v62-quick-seg button:not(:disabled):hover{background:rgba(20,20,18,0.04);}",
".project-marker.is-tl-predelivery{opacity:0.32;}",
".project-marker.is-tl-predelivery .project-marker__front,.project-marker.is-tl-predelivery .project-marker__east,.project-marker.is-tl-predelivery .project-marker__top{border-style:dashed;background:repeating-linear-gradient(135deg,rgba(252,251,248,0.6) 0 3px,rgba(20,20,18,0.05) 3px 6px);}",
      ".map-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;text-align:center;font-size:14px;line-height:1.45;color:var(--ink-soft);z-index:700;pointer-events:none;}",
      ".project-marker-icon{background:none;border:none;}",
      ".project-marker{position:relative;width:calc(var(--marker-width) + var(--marker-depth) + 16px);height:calc(var(--marker-height) + var(--marker-depth) + 18px);transition:opacity 140ms ease,transform 140ms ease;}",
      ".project-marker__shadow,.project-marker__front,.project-marker__east,.project-marker__top{position:absolute;display:block;}",
      ".project-marker.is-muted{opacity:0.22;}",
      ".project-marker__shadow{left:6px;bottom:4px;width:calc(var(--marker-width) + var(--marker-depth) + 4px);height:7px;border-radius:999px;background:rgba(16,16,15,0.05);filter:blur(1.5px);}",
      ".project-marker__front{left:4px;bottom:8px;width:var(--marker-width);height:var(--marker-height);background:rgba(252,251,248,0.22);border:1.1px solid rgba(20,20,18,0.82);box-shadow:inset 0 -1px 0 rgba(20,20,18,0.12);}",
      ".project-marker__east{left:calc(4px + var(--marker-width));bottom:8px;width:var(--marker-depth);height:var(--marker-height);background:rgba(20,20,18,0.08);border:1.1px solid rgba(20,20,18,0.75);transform-origin:left bottom;transform:skewY(-38deg);}",
      ".project-marker__top{left:4px;bottom:calc(8px + var(--marker-height));width:var(--marker-width);height:var(--marker-depth);background:rgba(252,251,248,0.34);border:1.1px solid rgba(20,20,18,0.78);transform-origin:left bottom;transform:skewX(-52deg);}",
      ".project-marker.is-lease-in-house .project-marker__front{border-color:#4E6148;background-color:rgba(95,110,90,0.18);}",
      ".project-marker.is-lease-in-house .project-marker__east{border-color:#3F5039;background-color:rgba(95,110,90,0.28);}",
      ".project-marker.is-lease-in-house .project-marker__top{border-color:#4E6148;background-color:rgba(95,110,90,0.14);}",
      ".project-marker.is-lease-outside-broker .project-marker__front{border-color:#9A6648;background-color:rgba(183,126,94,0.18);}",
      ".project-marker.is-lease-outside-broker .project-marker__east{border-color:#804F35;background-color:rgba(183,126,94,0.3);}",
      ".project-marker.is-lease-outside-broker .project-marker__top{border-color:#9A6648;background-color:rgba(183,126,94,0.14);}",
      ".project-marker.is-lease-unknown .project-marker__front,.project-marker.is-lease-unknown .project-marker__east,.project-marker.is-lease-unknown .project-marker__top{border-style:dashed;}",
      ".project-marker.is-hovered{transform:translateY(-1px);}",
      ".project-marker.is-hovered .project-marker__front,.project-marker.is-hovered .project-marker__east,.project-marker.is-hovered .project-marker__top{border-color:#6F8096;background-color:rgba(111,128,150,0.14);}",
      ".project-marker.is-selected{transform:translateY(-2px);}",
      ".project-marker.is-selected.is-lease-in-house .project-marker__front{background:#5F6E5A;border-color:#2E3A2A;}",
      ".project-marker.is-selected.is-lease-in-house .project-marker__east{background:#3F5039;border-color:#2E3A2A;}",
      ".project-marker.is-selected.is-lease-in-house .project-marker__top{background:#7A8B74;border-color:#2E3A2A;}",
      ".project-marker.is-selected.is-lease-outside-broker .project-marker__front{background:#B77E5E;border-color:#5A3920;}",
      ".project-marker.is-selected.is-lease-outside-broker .project-marker__east{background:#804F35;border-color:#5A3920;}",
      ".project-marker.is-selected.is-lease-outside-broker .project-marker__top{background:#CE9A7C;border-color:#5A3920;}",
      ".project-marker.is-selected.is-lease-unknown .project-marker__front{background:linear-gradient(180deg, #2b2f33 0%, #161718 100%);border-color:rgba(16,16,15,0.95);}",
      ".project-marker.is-selected.is-lease-unknown .project-marker__east{background:#0e0f10;border-color:rgba(16,16,15,0.92);}",
      ".project-marker.is-selected.is-lease-unknown .project-marker__top{background:#45494e;border-color:rgba(16,16,15,0.9);}",
      // spec-023j: targets-overlay highlight. Bright yellow on all three
      // faces overrides the gray fills so weak rentals POP when MODE = Targets.
      // Selected/hovered states still apply on top.
      ".project-marker.is-target-highlight .project-marker__front{border-color:#a8830a;background-color:#FFD600;}",
      ".project-marker.is-target-highlight .project-marker__east{border-color:#806208;background-color:#E0BB00;}",
      ".project-marker.is-target-highlight .project-marker__top{border-color:#a8830a;background-color:#FFE45C;}",
      ".project-marker.is-target-highlight.is-selected .project-marker__front{background:#FFEB3B;border-color:#5a4506;}",
      ".project-marker.is-target-highlight.is-selected .project-marker__east{background:#D4AC00;border-color:#5a4506;}",
      ".project-marker.is-target-highlight.is-selected .project-marker__top{background:#FFF176;border-color:#5a4506;}",
      ".project-tooltip-shell{background:rgba(247,244,238,0.96);border:1px solid rgba(20,20,18,0.25);box-shadow:var(--shadow);color:var(--ink);padding:0;font-family:'Times New Roman', Georgia, serif;}",
      ".project-tooltip-shell.leaflet-tooltip-right::before{border-right-color:rgba(247,244,238,0.96);}",
      ".project-tooltip-shell.leaflet-tooltip-left::before{border-left-color:rgba(247,244,238,0.96);}",
      ".project-tooltip{padding:10px 12px 9px;max-width:240px;}",
      ".project-tooltip__name{font-size:14px;line-height:1.2;}",
      ".project-tooltip__meta{margin-top:6px;font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-soft);}",
      ".project-tooltip__sub{margin-top:6px;font-family:Arial,sans-serif;font-size:11px;line-height:1.35;color:var(--ink-soft);}",
      ".project-tooltip.is-selected .project-tooltip__name{font-size:15px;}",
      ".dossier{padding:0;display:flex;flex-direction:column;min-height:100vh;background:var(--paper);border-left:1px solid var(--ink);box-shadow:-16px 0 32px rgba(31,31,28,0.06);}",
      ".dossier-rail{display:flex;flex-direction:column;min-height:100vh;background:var(--paper);}",
      ".dossier-head{position:sticky;top:0;z-index:5;background:var(--paper);border-bottom:1px solid var(--ink);padding:20px 24px 10px;}",
      ".dossier-head-inner{padding:20px 24px 10px 40px;}",
      ".dossier-kicker{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:10px;}",
      ".dossier-eyebrow{display:inline-flex;align-items:center;gap:8px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
      ".dossier-eyebrow::before{content:'';display:inline-block;width:8px;height:8px;background:#6f8096;}",
      ".dossier-close{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;background:transparent;color:var(--ink-soft);font-size:22px;line-height:1;cursor:pointer;padding:0;}",
      ".dossier-close:hover{color:var(--ink);}",
      ".dossier-close:focus-visible{outline:1px solid rgba(111,128,150,0.45);outline-offset:2px;}",
      ".dossier-title{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:22px;line-height:1.15;letter-spacing:-0.01em;margin:0 0 4px;font-weight:600;color:var(--ink);text-wrap:pretty;}",
      ".dossier-address{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:12px;line-height:1.5;color:var(--ink-soft);margin-bottom:10px;letter-spacing:0.02em;}",
      ".state-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;}",
      ".brief-chip{display:inline-flex;align-items:center;gap:6px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";padding:4px 10px;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;font-weight:600;border:1px solid var(--ink);background:rgba(255,255,255,0.52);color:var(--ink-soft);}",
      ".brief-chip.is-strong{background:var(--ink);border-color:var(--ink);color:var(--paper);}",
      ".brief-chip.is-tier-b{background:rgba(255,255,255,0.72);border-color:var(--ink);color:var(--ink);}",
      ".brief-chip.is-tier-c{background:transparent;border-color:var(--ink);color:var(--ink-faint);}",
      ".brief-chip.is-neutral{background:rgba(255,255,255,0.52);border-color:var(--line-strong);color:var(--ink-soft);}",
      ".brief-chip.is-active{background:#6f8096;border-color:#506174;color:var(--paper);}",
      ".brief-chip.is-lease-in-house{background:#5F6E5A;border-color:#3F5039;color:var(--paper);}",
      ".brief-chip.is-lease-broker{background:#B77E5E;border-color:#804F35;color:var(--paper);}",
      ".brief-chip.is-lease-unknown{background:rgba(255,255,255,0.52);border:1px dashed var(--line-strong);color:var(--ink-soft);}",
      // spec-023c: dev-pipeline marker / chip styling. Pipeline buildings
      // aren't being marketed yet — render with the muted future palette.
      ".brief-chip.is-lease-not-marketed-yet{background:rgba(255,255,255,0.5);border:1px dashed var(--line-strong);color:var(--ink-faint);}",
      ".project-marker.is-lease-not-marketed-yet .project-marker__front,.project-marker.is-lease-not-marketed-yet .project-marker__east,.project-marker.is-lease-not-marketed-yet .project-marker__top{border-style:dashed;}",
      ".map-legend-sw.is-lease-not-marketed-yet{border-style:dashed;background:rgba(216,214,209,0.35);}",
      ".legend-item.is-lease-not-marketed-yet::before{border-style:dashed;background:rgba(216,214,209,0.35);}",
      // spec-023c: dev-dossier sections. Reuse the existing dossier-section
      // layout but lay out fact rows as a tight label/value grid for the
      // Construction / Team / Sources blocks.
      ".dev-grid{display:flex;flex-direction:column;gap:6px;margin-top:4px;}",
      ".dev-row{display:grid;grid-template-columns:140px 1fr;gap:14px;align-items:baseline;padding:5px 0;border-bottom:1px solid var(--line);font-size:12px;}",
      ".dev-row:last-child{border-bottom:none;}",
      ".dev-row-label{font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--ink-soft);font-weight:500;}",
      ".dev-row-value{color:var(--ink);font-feature-settings:\"tnum\",\"ss01\";word-break:break-word;}",
      ".dev-empty{font-size:11.5px;color:var(--ink-faint);font-style:italic;line-height:1.45;padding:6px 0 4px;}",
      ".dev-link{color:var(--ink);text-decoration:none;border-bottom:1px solid var(--ink);padding-bottom:1px;word-break:break-all;}",
      ".dev-link:hover{color:var(--ink-soft);border-bottom-color:var(--ink-soft);}",
      // spec-023e: DM rows + prose blocks for contacts + permit sections.
      ".dev-dm-name{font-weight:600;color:var(--ink);}",
      ".dev-dm-title{color:var(--ink-soft);font-weight:400;}",
      // spec-025: italic muted badge for stage-heuristic completion dates.
      ".dev-est-badge{font-style:italic;color:var(--ink-faint);font-weight:400;font-size:11px;margin-left:6px;}",
      // spec-024: Supply pressure section.
      ".v62-pressure-headline{font-size:13px;color:var(--ink);font-weight:500;margin-top:6px;letter-spacing:0;}",
      ".v62-pressure-blocks{font-variant-numeric:tabular-nums;}",
      ".v62-pressure-units{color:var(--ink-soft);font-weight:400;font-variant-numeric:tabular-nums;}",
      ".v62-pressure-window{font-size:11px;color:var(--ink-faint);margin-top:2px;letter-spacing:0;}",
      ".v62-pressure-pitch{font-style:italic;color:var(--ink-soft);font-size:12px;line-height:1.5;margin-top:8px;}",
      ".v62-pressure-empty{font-style:italic;color:var(--ink-faint);font-size:12px;line-height:1.5;margin-top:6px;}",
      ".v62-pressure-toggle{display:flex;gap:4px;margin-top:10px;}",
      ".v62-pressure-toggle-btn{padding:3px 9px;background:transparent;color:var(--ink-faint);border:1px solid var(--line);font-family:inherit;font-size:10px;letter-spacing:0.16em;text-transform:uppercase;font-weight:600;cursor:pointer;}",
      ".v62-pressure-toggle-btn.is-active{background:var(--ink);color:#fcfbf8;border-color:var(--ink);}",
      ".v62-pressure-toggle-btn:hover:not(.is-active){color:var(--ink);}",
      ".v62-pressure-table{margin-top:8px;display:flex;flex-direction:column;gap:1px;background:var(--line);}",
      ".v62-pressure-row{display:grid;grid-template-columns:1.5fr 1.5fr 1fr;gap:8px;align-items:center;padding:7px 10px;background:var(--paper);border:none;cursor:pointer;text-align:left;font-family:inherit;}",
      ".v62-pressure-row:hover{background:#f8f5ef;}",
      ".v62-pressure-row-name{font-size:12.5px;color:var(--ink);font-weight:500;}",
      ".v62-pressure-row-meta{font-size:11px;color:var(--ink-soft);}",
      ".v62-pressure-row-tail{font-size:11px;color:var(--ink-soft);font-variant-numeric:tabular-nums;text-align:right;display:flex;flex-direction:column;gap:1px;}",
      ".v62-pressure-date{}",
      ".v62-pressure-dist{color:var(--ink-faint);}",
      ".v62-pressure-est{font-style:italic;color:var(--ink-faint);}",
      ".v62-pressure-delivered{font-style:italic;color:var(--ink-faint);}",
      ".dev-prose-block{margin-top:8px;padding:8px 0 4px;}",
      ".dev-prose-label{font-size:9.5px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;margin-bottom:3px;}",
      ".dev-prose{font-size:11.5px;color:var(--ink-soft);line-height:1.5;word-wrap:break-word;}",
      // spec-023g: broker-narrative + per-filing list styling.
      ".dev-narrative{margin-top:10px;padding:10px 12px;background:rgba(255,255,255,0.55);border-left:2px solid var(--ink);border-radius:0 4px 4px 0;}",
      ".dev-narrative-text{font-size:12.5px;color:var(--ink);line-height:1.5;font-style:italic;}",
      ".dev-filings-list{list-style:none;margin:6px 0 0;padding:0;font-feature-settings:\"tnum\";}",
      ".dev-filing{padding:4px 0;border-bottom:1px solid var(--line);font-size:11px;color:var(--ink-soft);}",
      ".dev-filing:last-child{border-bottom:none;}",
      ".dev-filing.is-recent{color:var(--ink);font-weight:500;}",
      ".dev-filing-link{color:var(--ink);font-family:\"Menlo\",monospace;font-size:10.5px;letter-spacing:0;text-decoration:none;border-bottom:1px dotted var(--line-strong);}",
      ".dev-filing-link:hover{border-bottom-color:var(--ink);}",
      ".dev-filing-meta{color:var(--ink-faint);font-size:10.5px;margin-left:6px;}",
      ".dev-filing-flag{display:inline-block;font-size:8.5px;letter-spacing:0.1em;font-weight:600;color:var(--paper);background:var(--ink);padding:1px 5px;border-radius:2px;margin-right:5px;vertical-align:1px;}",
      ".brief-chip.is-success{background:#3d5c48;border-color:#2e4738;color:var(--paper);}",
      ".brief-chip.is-alert{background:#7b4a38;border-color:#5b3326;color:var(--paper);}",
      ".brief-chip.is-disabled{cursor:not-allowed;}",
      ".state-meta{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:var(--ink-faint);padding:4px 2px;}",
      ".action-cluster{padding:10px 16px 12px;display:flex;gap:6px;flex-wrap:wrap;background:rgba(255,255,255,0.72);border-top:1px solid var(--line);}",
      ".action-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center;width:100%;}",
      ".action-chip{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9.5px;letter-spacing:0.14em;text-transform:uppercase;font-weight:600;background:var(--paper);color:var(--ink);border:1px solid var(--line-strong);cursor:not-allowed;}",
      ".action-chip.is-primary{background:var(--ink);border-color:var(--ink);color:var(--paper);}",
      ".action-chip.is-disabled{opacity:0.55;border-style:dashed;color:var(--ink-faint);}",
      ".action-chip.is-primary.is-disabled{background:var(--ink);color:var(--paper);opacity:0.55;border-style:dashed;}",
      ".action-chip svg{flex-shrink:0;}",
      ".action-support{padding:6px 24px 10px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10.5px;line-height:1.5;color:var(--ink-faint);background:var(--paper);border-top:1px solid var(--line);border-bottom:1px solid var(--line);}",
      ".next-action-banner{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:12px;padding:12px 20px 14px;align-items:stretch;background:var(--paper);border-bottom:1px solid var(--ink);}",
      ".next-action-label,.metric-label,.signal-meta,.contact-meta,.detail-card-kicker,.empty-card-kicker{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;}",
      ".next-action-text{margin-top:3px;font-size:13px;line-height:1.4;color:var(--ink);text-wrap:pretty;}",
      ".next-action-meta{margin-top:6px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11px;line-height:1.45;color:var(--ink-soft);}",
      ".cta-row{margin-top:8px;display:flex;flex-wrap:wrap;gap:8px;align-items:center;}",
      ".cta-button{display:inline-flex;align-items:center;padding:4px 10px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.22em;text-transform:uppercase;font-weight:600;background:var(--ink);color:var(--paper);border:1px solid var(--ink);}",
      ".cta-button.is-disabled{background:var(--ink);color:var(--paper);opacity:0.45;border-style:dashed;cursor:not-allowed;}",
      ".cta-note{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10.5px;line-height:1.45;color:var(--ink-faint);}",
      ".priority-stack{text-align:right;display:flex;flex-direction:column;justify-content:flex-start;padding-left:14px;border-left:1px solid var(--line);min-width:92px;}",
      ".priority-value{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:22px;line-height:1;color:#6f8096;font-weight:600;font-variant-numeric:tabular-nums;}",
      ".priority-sub{margin-top:6px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;letter-spacing:0.1em;text-transform:uppercase;color:var(--ink-soft);}",
      ".priority-sub.is-overdue{color:#7B4A38;}",
      ".dossier-body{padding:20px 24px 40px;display:flex;flex-direction:column;gap:22px;}",
      ".section{display:flex;flex-direction:column;gap:10px;}",
      ".section-head{display:flex;justify-content:space-between;align-items:baseline;padding-bottom:6px;border-bottom:1px solid var(--line);}",
      ".section-title{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.3em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
      ".section-suffix{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;color:var(--ink-faint);}",
      ".note-block,.detail-card,.empty-card,.decision-card,.org-card,.contact-card,.signal{padding:12px 14px;border:1px solid var(--line);background:var(--paper);}",
      ".note-block{font-size:13px;line-height:1.55;color:var(--ink);text-wrap:pretty;}",
      ".empty-card{border-style:dashed;}",
      ".detail-card-title,.decision-name,.org-name,.contact-name{font-size:15px;line-height:1.35;color:var(--ink);}",
      ".detail-card-body,.decision-meta,.decision-detail,.org-meta,.contact-detail{margin-top:6px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11px;line-height:1.5;color:var(--ink-soft);}",
      ".empty-card{border-style:dashed;}",
      ".org-list,.contact-list,.signal-list{display:flex;flex-direction:column;gap:8px;}",
      ".signal-head{font-size:16px;line-height:1.22;margin:6px 0;}",
      ".signal-body{font-size:14px;line-height:1.45;color:var(--ink-soft);}",
      ".empty{font-size:14px;color:var(--ink-soft);}",
      /* 014C / OperatingDossier61 additions */
      ".dossier-eyebrow-id{color:var(--ink-soft);font-weight:600;}",
      ".dossier-title-row{font-size:22px;color:var(--ink);font-weight:600;letter-spacing:-0.01em;line-height:1.15;margin:0 0 4px;text-wrap:pretty;}",
      ".cta-button svg{margin-left:4px;}",
      ".cta-button.is-disabled{opacity:0.45;border-style:dashed;cursor:not-allowed;}",
      ".fub-list{display:flex;flex-direction:column;gap:6px;}",
      ".fub-row{display:flex;align-items:center;gap:10px;padding:9px 12px;background:var(--paper);border:1px solid var(--line);}",
      ".fub-edit{background:transparent;border:1px solid var(--line);padding:4px 8px;cursor:pointer;color:var(--ink-soft);font:inherit;font-size:11px;line-height:1;}",
      ".fub-edit:hover{color:var(--ink);border-color:var(--line-strong);}",
      ".fub-chip{display:inline-flex;align-items:center;gap:6px;padding:4px 8px;border:1px solid var(--line-strong);background:var(--paper);color:var(--ink);font-family:Arial,sans-serif;font-size:10px;letter-spacing:0.08em;text-transform:uppercase;text-decoration:none;cursor:pointer;}",
      ".fub-chip:hover{background:rgba(20,20,18,0.06);}",
      ".fub-chip.is-linked{border-color:var(--ink);color:var(--ink);}",
      ".fub-chip.is-unlinked{border-style:dashed;color:var(--ink-faint);cursor:not-allowed;opacity:0.75;}",
      ".fub-chip svg{width:12px;height:12px;}",
      ".fub-chip-label{line-height:1;}",
      ".fub-avatar{width:28px;height:28px;border-radius:999px;background:rgba(255,255,255,0.7);border:1px solid var(--line);display:grid;place-items:center;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;font-weight:600;color:var(--ink-soft);letter-spacing:0.05em;flex-shrink:0;}",
      ".fub-body{flex:1;min-width:0;}",
      ".fub-name{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:12.5px;color:var(--ink);font-weight:500;}",
      ".fub-meta{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10.5px;color:var(--ink-faint);margin-top:2px;}",
      ".fub-link{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9.5px;color:var(--ink-faint);letter-spacing:0.18em;text-transform:uppercase;font-weight:600;text-decoration:none;}",
      ".fub-link.is-disabled{cursor:not-allowed;opacity:0.6;}",
      ".mini-grid{display:grid;grid-template-columns:1fr 1fr;gap:4px 20px;}",
      ".mini-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:0.5px dotted var(--line);gap:8px;min-height:26px;}",
      ".mini-label{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9.5px;letter-spacing:0.2em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;}",
      ".mini-value{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11.5px;color:var(--ink);text-align:right;display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;}",
      ".mini-value.is-editable-val{cursor:text;padding:2px 6px;margin:-2px -6px;border-radius:3px;outline:none;max-width:100%;}",
      ".mini-value.is-editable-val:hover{background:rgba(20,20,18,0.05);}",
      ".mini-value.is-editable-val:focus{background:rgba(111,128,150,0.1);box-shadow:inset 0 0 0 1px rgba(111,128,150,0.4);}",
      ".mini-value .editable-text{min-width:0;overflow:hidden;text-overflow:ellipsis;}",
      ".mini-value .editable-text.is-empty{color:var(--ink-faint);font-style:italic;}",
      ".mini-value .editable-pencil{opacity:0;font-size:10px;color:var(--ink-faint);transition:opacity 120ms ease;flex-shrink:0;}",
      ".mini-value.is-editable-val:hover .editable-pencil,.mini-value.is-editable-val:focus .editable-pencil{opacity:0.7;}",
      ".mini-value .editable-input{font:inherit;font-size:11.5px;color:var(--ink);background:#fff;border:1px solid var(--accent);padding:2px 6px;margin:-2px 0;outline:none;text-align:right;width:100%;min-width:120px;box-shadow:0 0 0 2px rgba(111,128,150,0.15);}",
      ".mini-value .editable-input:focus{border-color:var(--ink);}",
      ".signal-dot{display:inline-block;width:7px;height:7px;border-radius:999px;flex-shrink:0;}",
      ".signal-dot.is-active{background:#5E718A;}",
      ".signal-dot.is-warn{background:#7B4A38;}",
      ".signal-dot.is-long{background:#B77E5E;}",
      ".signal-dot.is-fresh{background:#5F6E5A;}",
      ".signal-dot.is-neutral{background:var(--ink-faint);}",
      ".editable-block{width:100%;background:var(--paper);border:1px solid var(--line);padding:12px 14px;font-family:inherit;text-align:left;display:flex;justify-content:space-between;align-items:flex-start;gap:12px;color:var(--ink-soft);cursor:not-allowed;}",
      ".editable-block.is-dashed{border-style:dashed;}",
      ".edit-glyph{width:10px;height:10px;flex-shrink:0;color:var(--ink-faint);}",
      ".kv-stack{display:flex;flex-direction:column;gap:3px;}",
      ".kv-label{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.22em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;}",
      ".kv-value{font-size:12px;color:var(--ink);}",
      ".kv-sub{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10.5px;color:var(--ink-faint);margin-top:4px;}",
      ".kv-empty{font-size:12px;color:var(--ink-faint);font-style:italic;}",
      ".callout{margin-top:10px;padding:8px 12px;background:rgba(255,255,255,0.55);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11.5px;color:var(--ink-soft);line-height:1.45;}",
      ".empty-soft{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11.5px;color:var(--ink-faint);font-style:italic;padding:8px 0;line-height:1.5;}",
".empty-stats{padding:14px 16px;border:1px solid var(--line);background:rgba(255,255,255,0.55);}",
".empty-stats-kicker{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.28em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;margin-bottom:10px;}",
".empty-stats-row{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;}",
".empty-stat{display:flex;flex-direction:column;gap:4px;}",
".empty-stat-n{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:24px;font-weight:600;color:var(--ink);line-height:1;font-variant-numeric:tabular-nums;letter-spacing:-0.01em;}",
".empty-stat-label{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--ink-faint);font-weight:500;}",
".empty-section-head{display:flex;align-items:baseline;justify-content:space-between;margin-top:4px;}",
".empty-section-head .section-suffix,.empty-section-head .ai-glyph{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;color:var(--ink-faint);}",
".empty-section-head .ai-glyph{color:#6f8096;font-size:12px;}",
".queue-card{display:flex;align-items:center;gap:12px;width:100%;padding:12px 14px;border:1px solid var(--line);background:var(--paper);text-align:left;cursor:pointer;font-family:inherit;transition:background 120ms, border-color 120ms;}",
".queue-card:hover{background:rgba(255,255,255,0.7);border-color:var(--ink);}",
".queue-card-left{flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;}",
".queue-card-title{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:14px;font-weight:600;color:var(--ink);line-height:1.25;letter-spacing:-0.005em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
".queue-card-addr{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11px;color:var(--ink-soft);line-height:1.35;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
".queue-card-reasons{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px;}",
".queue-reason{display:inline-flex;align-items:center;padding:2px 7px;font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;letter-spacing:0.16em;text-transform:uppercase;font-weight:600;border:1px solid var(--line-strong);color:var(--ink-soft);background:var(--paper);}",
".queue-reason.is-alert{background:#7b4a38;border-color:#5b3326;color:var(--paper);}",
".queue-reason.is-warm{background:rgba(183,126,94,0.15);border-color:#b77e5e;color:#7b4a38;}",
".queue-reason.is-strong{background:var(--ink);border-color:var(--ink);color:var(--paper);}",
".queue-card-arrow{font-size:20px;color:var(--ink-faint);line-height:1;flex-shrink:0;}",
".agent-card{display:flex;align-items:flex-start;gap:10px;padding:12px 14px;border:1px solid var(--line);background:rgba(111,128,150,0.06);}",
".agent-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;flex-shrink:0;background:#6f8096;color:var(--paper);font-size:11px;border-radius:999px;margin-top:1px;}",
".agent-body{flex:1;display:flex;flex-direction:column;gap:4px;min-width:0;}",
".agent-text{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:12.5px;line-height:1.45;color:var(--ink);text-wrap:pretty;}",
".agent-meta{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--ink-faint);font-weight:600;}",
      ".note-composer{display:flex;gap:6px;}",
      ".note-composer input{flex:1;padding:8px 10px;border:1px solid var(--line-strong);background:var(--paper);font-family:inherit;font-size:12px;color:var(--ink);outline:none;}",
      ".note-composer input:focus{border-color:var(--ink);}",
      ".note-composer button{padding:0 14px;background:var(--ink);color:var(--paper);border:1px solid var(--ink);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9.5px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;cursor:not-allowed;opacity:0.55;}",
      ".note-log{display:flex;flex-direction:column;gap:6px;margin-top:8px;}",
      ".note-entry{padding:8px 12px;background:rgba(255,255,255,0.55);font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:11.5px;color:var(--ink-soft);line-height:1.45;border-left:2px solid var(--line);}",
      ".note-entry-date{font-family:Inter,\"Helvetica Neue\",Arial,sans-serif;font-feature-settings:\"ss01\",\"cv11\";font-size:9px;color:var(--ink-faint);letter-spacing:0.18em;text-transform:uppercase;margin-bottom:3px;}",
      "@media (max-width: 960px){.shell{grid-template-columns:280px 1fr;}.dossier{grid-column:1 / -1;border-left:none;border-top:1px solid var(--ink);box-shadow:none;}}",
      "@media (max-width: 820px){.shell{grid-template-columns:1fr;}.rail{border-right:none;border-bottom:1px solid var(--line);}.world{padding:14px;}.world::before{inset:14px;}.world-inner{height:620px;min-height:620px;}.world-head{flex-direction:column;}.stats{flex-wrap:wrap;gap:10px 14px;}.legend{left:12px;right:12px;bottom:10px;flex-direction:column;gap:8px;}.next-action-banner{grid-template-columns:1fr;}.priority-stack{text-align:left;border-left:none;border-top:1px solid var(--line);padding-left:0;padding-top:12px;}}"
    ].join("");
    app.appendChild(style);

    const shell = createEl("div", "v62-shell");
    app.appendChild(shell);

    // HEADER BAND
    const header = createEl("header", "v62-header");

    const identity = createEl("div", "v62-identity");
    const logo = createEl("img", "v62-identity-logo");
    logo.src = (window.__resources && window.__resources.bondLogo) || "./bond-ny-logo.png";
    logo.alt = "BOND New York";
    identity.appendChild(logo);
    header.appendChild(identity);

    // Pulse strip (center cell)
    const pulse = createEl("div", "v62-pulse");
    nodes.pulseLabel = createEl("span", "v62-pulse-label", "In lens");
    pulse.appendChild(nodes.pulseLabel);
    nodes.pulseTotal = createEl("span", "v62-pulse-total", "0");
    pulse.appendChild(nodes.pulseTotal);
    pulse.appendChild(createEl("span", "v62-sep"));

    nodes.kpiPrio = kpiNode("Prio A", "0");
    pulse.appendChild(nodes.kpiPrio);
    nodes.kpiDm = kpiNode("DM", "0/0");
    pulse.appendChild(nodes.kpiDm);
    nodes.kpiFub = kpiNode("FUB", "0/0");
    pulse.appendChild(nodes.kpiFub);
    nodes.kpiDue = kpiNode("Due", "0", true);
    pulse.appendChild(nodes.kpiDue);

    pulse.appendChild(createEl("span", "v62-sep"));
    nodes.stateChipStrip = createEl("span", "v62-statechips");
    pulse.appendChild(nodes.stateChipStrip);
    header.appendChild(pulse);

    // Mode switch — spec-023j: World/Targets are now live; Pressure stays
    // disabled (no pressure-mode behavior yet).
    const modeCell = createEl("div", "v62-mode");
    modeCell.appendChild(createEl("div", "v62-mode-label", "Mode"));
    const modeGroup = createEl("div", "v62-mode-group");
    nodes.modeButtons = {};
    ["World", "Targets", "Pressure"].forEach(function (label) {
      const isLive = (label === "World" || label === "Targets");
      const isActive = (label === "World" && !targetsOverlayActive)
        || (label === "Targets" && targetsOverlayActive);
      const btn = createEl("button", "v62-mode-btn"
        + (isLive ? "" : " is-disabled")
        + (isActive ? " is-active" : ""));
      btn.type = "button";
      btn.textContent = label;
      if (!isLive) {
        btn.disabled = true;
        btn.title = "Pressure mode not wired in this pilot";
      } else {
        btn.title = label === "Targets"
          ? "Highlight the top 10% weakest rentals on the map"
          : "Default view — show all buildings without weakness highlight";
        btn.addEventListener("click", function () {
          setTargetsOverlay(label === "Targets");
        });
      }
      nodes.modeButtons[label] = btn;
      modeGroup.appendChild(btn);
    });
    modeCell.appendChild(modeGroup);
    header.appendChild(modeCell);
    shell.appendChild(header);

    // spec-021: discovery bar (sub-header). Floats below the main header,
    // full-width. Holds the natural-language input + sample-question chips.
    // Plain English chips only — never include catchphrases.
    nodes.discoveryBar = buildDiscoveryBar();
    shell.appendChild(nodes.discoveryBar);

    // BODY — lens rail + aperture + dossier
    const body = createEl("div", "v62-body");

    // LEFT LENS RAIL
    const lens = createEl("aside", "v62-lens");
    buildLensRail(lens);
    body.appendChild(lens);

    // CENTER APERTURE (map)
    const aperture = createEl("main", "v62-aperture");
    nodes.mapCanvas = createEl("div", "map-canvas");
    nodes.mapCanvas.style.position = "absolute";
    nodes.mapCanvas.style.inset = "0";
    aperture.appendChild(nodes.mapCanvas);
    nodes.mapEmpty = createEl("div", "map-empty");
    nodes.mapEmpty.hidden = true;
    aperture.appendChild(nodes.mapEmpty);
    // Map legend — floating bottom-right, compact with expand
    const legend = createEl("div", "map-legend");
    const legendHead = createEl("button", "map-legend-head");
    legendHead.type = "button";
    legendHead.setAttribute("aria-expanded", "false");
    legendHead.appendChild(createEl("span", "map-legend-glyph", "◔"));
    legendHead.appendChild(createEl("span", "map-legend-label", "Legend"));
    legendHead.appendChild(createEl("span", "map-legend-caret", "›"));
    legend.appendChild(legendHead);

    const legendBody = createEl("div", "map-legend-body");
    legend.appendChild(legendBody);

    function legendGroup(title, rows) {
      const g = createEl("div", "map-legend-group");
      g.appendChild(createEl("div", "map-legend-group-title", title));
      rows.forEach(function (r) {
        const row = createEl("div", "map-legend-row");
        row.appendChild(createEl("span", "map-legend-sw " + (r.cls || ""), ""));
        row.appendChild(createEl("span", "map-legend-text", r.label));
        g.appendChild(row);
      });
      legendBody.appendChild(g);
    }
    legendGroup("Leasing mode (marker fill)", [
      { cls: "is-lease-in-house", label: "In-house leasing" },
      { cls: "is-lease-outside-broker", label: "Outside broker" },
      { cls: "is-lease-unknown", label: "Unknown" },
      { cls: "is-lease-not-marketed-yet", label: "Not marketed yet (pipeline)" }
    ]);
    legendGroup("Rank tier (marker height)", [
      { cls: "is-rank-a", label: "A · priority" },
      { cls: "is-rank-b", label: "B · standard" },
      { cls: "is-rank-c", label: "C · backlog" }
    ]);
    legendGroup("Pipeline state (header chips)", [
      { cls: "is-state-pitched", label: "Pitched / Won" },
      { cls: "is-state-discussion", label: "In discussion" },
      { cls: "is-state-pitch", label: "Needs pitch" },
      { cls: "is-state-alert", label: "Follow-up due · Stale · Lost" }
    ]);

    legendHead.addEventListener("click", function () {
      const isOpen = legend.classList.toggle("is-open");
      legendHead.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    aperture.appendChild(legend);

    // spec-025g: recenter button. Pinned next to the Legend pill so the
    // user can snap the map back to the Manhattan-fit view after panning
    // or zooming away. Calls fitMapToProjects() which uses the same
    // bounds.fitBounds() math the initial render uses.
    const recenter = createEl("button", "map-recenter");
    recenter.type = "button";
    recenter.title = "Recenter on Manhattan";
    recenter.setAttribute("aria-label", "Recenter on Manhattan");
    recenter.appendChild(createEl("span", "map-recenter-glyph", "⌖"));
    recenter.appendChild(createEl("span", "map-recenter-label", "Recenter"));
    recenter.addEventListener("click", function () {
      if (typeof fitMapToProjects === "function") fitMapToProjects(true);
    });
    aperture.appendChild(recenter);

    // TIMELINE SLIDER — bottom-center, filters upcoming deliveries by estimated_target_date
    // Range 2026 Q1 → 2031 Q4, quarterly granularity (24 ticks).
    const TL_QUARTERS = [];
    for (let y = 2026; y <= 2031; y++) {
      for (let q = 1; q <= 4; q++) TL_QUARTERS.push({ year: y, quarter: q });
    }
    const TL_INITIAL = 2; // default: Q3 2026 — shows 520 Fifth (Q4 2026) as not-yet-delivered
    const timeline = createEl("div", "map-timeline");
    const tlHead = createEl("div", "map-timeline-head");
    tlHead.appendChild(createEl("span", "map-timeline-kicker", "Timeline · Est. delivery"));
    nodes.timelineValue = createEl("span", "map-timeline-value");
    tlHead.appendChild(nodes.timelineValue);
    timeline.appendChild(tlHead);

    const track = createEl("div", "map-timeline-track");
    track.appendChild(createEl("div", "map-timeline-rail"));
    nodes.timelineFill = createEl("div", "map-timeline-fill");
    track.appendChild(nodes.timelineFill);
    const ticks = createEl("div", "map-timeline-ticks");
    TL_QUARTERS.forEach(function (q, i) {
      const t = createEl("div", "map-timeline-tick" + (q.quarter === 1 ? " is-year" : ""));
      t.style.left = (i / (TL_QUARTERS.length - 1) * 100) + "%";
      ticks.appendChild(t);
    });
    track.appendChild(ticks);

    nodes.timelineInput = createEl("input", "map-timeline-input");
    nodes.timelineInput.type = "range";
    nodes.timelineInput.min = "0";
    nodes.timelineInput.max = String(TL_QUARTERS.length - 1);
    nodes.timelineInput.step = "1";
    nodes.timelineInput.value = String(TL_INITIAL);
    nodes.timelineInput.setAttribute("aria-label", "Filter map by estimated delivery quarter");
    track.appendChild(nodes.timelineInput);
    timeline.appendChild(track);

    const scale = createEl("div", "map-timeline-scale");
    ["2026", "2027", "2028", "2029", "2030", "2031"].forEach(function (y) {
      scale.appendChild(createEl("span", "", y));
    });
    timeline.appendChild(scale);

    nodes.timelineCaption = createEl("div", "map-timeline-caption");
    timeline.appendChild(nodes.timelineCaption);

    function applyTimeline() {
      const idx = Number(nodes.timelineInput.value) || 0;
      const cur = TL_QUARTERS[idx];
      const pct = TL_QUARTERS.length > 1 ? (idx / (TL_QUARTERS.length - 1)) * 100 : 0;
      nodes.timelineFill.style.width = pct + "%";
      nodes.timelineValue.textContent = "Q" + cur.quarter + " " + cur.year;

      // Build cutoff date = last day of quarter
      const qEndMonth = cur.quarter * 3; // Q1→3, Q2→6, Q3→9, Q4→12
      const cutoff = new Date(cur.year, qEndMonth, 0); // day 0 of next month = last day

      let shown = 0, hidden = 0, predelivery = 0;
      mappableProjects.forEach(function (p) {
        const marker = markerById.get(p.project_id);
        if (!marker) return;
        const status = String(p.map.canonical_status || p.facts.canonical_status || "").toLowerCase();
        const isStanding = status === "standing-building";
        const el = marker.getElement && marker.getElement();
        const inner = el && el.querySelector(".project-marker");
        if (!inner) return;

        inner.classList.remove("is-tl-hidden", "is-tl-predelivery");

        if (isStanding) {
          shown++;
          return; // standing buildings always visible, unaffected by slider
        }

        // Upcoming: look at estimated_target_date
        const target = p.map.estimated_target_date || p.facts.estimated_target_date;
        if (!target) {
          shown++;
          return; // no date = always show (fail open)
        }
        const targetDate = new Date(target);
        const startRaw = p.map.estimated_start_date || p.facts.estimated_start_date;
        const startDate = startRaw ? new Date(startRaw) : null;

        if (targetDate <= cutoff) {
          // delivered by cutoff — show solid
          shown++;
        } else if (startDate && startDate <= cutoff) {
          // under construction at cutoff — show with pre-delivery treatment
          inner.classList.add("is-tl-predelivery");
          predelivery++;
        } else {
          // not started yet at cutoff — hide
          inner.classList.add("is-tl-hidden");
          hidden++;
        }
      });

      const parts = [];
      if (shown) parts.push("<b>" + shown + "</b> delivered");
      if (predelivery) parts.push("<b>" + predelivery + "</b> under construction");
      if (hidden) parts.push("<b>" + hidden + "</b> pre-start (hidden)");
      nodes.timelineCaption.innerHTML = parts.length
        ? parts.join(" · ")
        : "No upcoming projects in this window.";
    }
    nodes.timelineInput.addEventListener("input", applyTimeline);
    nodes.applyTimeline = applyTimeline; // so initMap can call after markers exist

    aperture.appendChild(timeline);

    // Position timeline horizontally centered over the map column (not viewport).
    // Since the page body scrolls but the timeline is fixed, we anchor via aperture rect.
    function positionTimeline() {
      const rect = aperture.getBoundingClientRect();
      const tlWidth = timeline.offsetWidth || 620;
      const centerX = rect.left + rect.width / 2;
      let leftPx = centerX - tlWidth / 2;
      // Clamp within aperture bounds
      leftPx = Math.max(rect.left + 12, Math.min(leftPx, rect.right - tlWidth - 12));
      timeline.style.left = leftPx + "px";
    }
    positionTimeline();
    window.addEventListener("resize", positionTimeline);
    window.addEventListener("scroll", positionTimeline, { passive: true });
    body.appendChild(aperture);

    // RIGHT DOSSIER RAIL
    nodes.dossier = createEl("aside", "dossier");
    body.appendChild(nodes.dossier);

    shell.appendChild(body);
  }

  // ---- Discovery query box (CODEX-SPEC-021) -------------------------------
  // Floats below the main header. Plain-English chips on first load; once
  // the input has content, the user submits with Enter and the right rail
  // renders a "Targets · n=N" list with broker-internal punchy templates.
  // Click a target row → standard dossier loads for that building.
  //
  // State (DISCOVERY_CHIPS, discoveryActive, discoveryResults, discoveryError)
  // declared near top of IIFE to avoid temporal-dead-zone when buildShell
  // calls buildDiscoveryBar().

  function buildDiscoveryBar() {
    const bar = createEl("div", "v62-discovery");

    const wrap = createEl("div", "v62-discovery-input-wrap");
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("width", "11");
    icon.setAttribute("height", "11");
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", "7"); c.setAttribute("cy", "7"); c.setAttribute("r", "4.5");
    c.setAttribute("fill", "none"); c.setAttribute("stroke", "#5b5b56"); c.setAttribute("stroke-width", "1");
    icon.appendChild(c);
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", "10.5"); l.setAttribute("y1", "10.5"); l.setAttribute("x2", "14"); l.setAttribute("y2", "14");
    l.setAttribute("stroke", "#5b5b56"); l.setAttribute("stroke-width", "1"); l.setAttribute("stroke-linecap", "round");
    icon.appendChild(l);
    wrap.appendChild(icon);

    const input = createEl("input", "v62-discovery-input");
    input.type = "text";
    input.placeholder = "Ask for buildings (e.g. Hell's Kitchen 1BRs leasing slowest)…";
    input.title = "Natural-language discovery — query the corpus by signal type, neighborhood, tier";
    input.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") {
        const q = input.value.trim();
        if (q) runDiscoveryQuery(q);
      } else if (evt.key === "Escape") {
        clearDiscovery();
      }
    });
    input.addEventListener("input", function () {
      // Show / hide the chip strip based on input emptiness.
      const empty = !input.value.trim();
      if (nodes.discoveryChips) {
        nodes.discoveryChips.style.display = empty ? "flex" : "none";
      }
      if (nodes.discoveryClear) {
        nodes.discoveryClear.style.display = empty ? "none" : "inline-block";
      }
    });
    nodes.discoveryInput = input;
    wrap.appendChild(input);

    const clearBtn = createEl("button", "v62-discovery-clear", "×");
    clearBtn.type = "button";
    clearBtn.title = "Clear (Esc)";
    clearBtn.style.display = "none";
    clearBtn.addEventListener("click", clearDiscovery);
    nodes.discoveryClear = clearBtn;
    wrap.appendChild(clearBtn);

    bar.appendChild(wrap);

    // Sample-question chips (plain-English; never include catchphrases).
    const chips = createEl("div", "v62-discovery-chips");
    DISCOVERY_CHIPS.forEach(function (q) {
      const chip = createEl("button", "v62-discovery-chip", q);
      chip.type = "button";
      chip.addEventListener("click", function () {
        input.value = q;
        nodes.discoveryClear.style.display = "inline-block";
        chips.style.display = "none";
        runDiscoveryQuery(q);
      });
      chips.appendChild(chip);
    });
    nodes.discoveryChips = chips;
    bar.appendChild(chips);

    const status = createEl("div", "v62-discovery-status", "");
    nodes.discoveryStatus = status;
    bar.appendChild(status);

    // Initial chip visibility — `input` events only fire on user typing,
    // so if the browser autofills or the page loads with input content
    // the chips would otherwise stay visible while the input has text.
    const empty = !input.value.trim();
    chips.style.display = empty ? "flex" : "none";
    clearBtn.style.display = empty ? "none" : "inline-block";

    return bar;
  }

  function runDiscoveryQuery(q) {
    discoveryActive = true;
    discoveryError = null;
    discoveryResults = null;
    nodes.discoveryStatus.textContent = "Searching…";
    renderDossier();
    // spec-023i: pipeline chips short-circuit the rentals discovery API
    // and run client-side against the dev-buildings layer (which is
    // already in projects[] from payload-dev.js).
    if (PIPELINE_CHIP_LABELS.has(q)) {
      const local = runPipelineChip(q);
      discoveryResults = local;
      discoveryError = null;
      nodes.discoveryStatus.textContent = "n=" + (local.result_count || 0);
      renderDossier();
      // spec-025d: pipeline-chip path also narrows the map lens.
      applyAllFilters();
      // spec-026: zoom the map to the chip's target cohort so the
      // user sees the cluster without manually panning.
      fitMapToTargets(true);
      return;
    }
    // spec-023s: outside-rep / mode-specific rental chips. Hit the deeper
    // weak-targets pool then client-filter — the Haiku discovery API tops
    // out at top-20-by-score which is in-house dominated.
    if (RENTAL_LOCAL_CHIP_LABELS.has(q)) {
      runRentalLocalChip(q);
      return;
    }
    // spec-027 / phase-2c: wmFetchDiscoveryQuery() falls through to the
    // deployed Fly.io dev-server when no local one is running.
    // spec-025f: ask for a deep pool so the Outside / In-house toggle in the
    // right rail has enough headroom to slice off the in-house-dominant
    // top-N. The Haiku LLM-parser may emit limit=20; this client override
    // pins the request to 200 so the score-ranking returns up to 200
    // matches and the mode toggle gets meaningful slices.
    wmFetchDiscoveryQuery({q: q, limit: 200})
      .then(function (resp) {
        return resp.json().then(function (data) {
          return {ok: resp.ok, status: resp.status, data: data};
        });
      })
      .then(function (r) {
        if (!r.ok) {
          discoveryError = (r.data && r.data.error && r.data.error.message)
            || ("HTTP " + r.status);
          discoveryResults = null;
        } else {
          discoveryError = null;
          discoveryResults = r.data;
        }
        nodes.discoveryStatus.textContent = discoveryResults
          ? ("n=" + (discoveryResults.result_count || 0))
          : "";
        renderDossier();
        // spec-025d: narrow the map lens to the discovered project_ids
        // so the visualization mirrors the right-rail Targets list.
        applyAllFilters();
        // spec-026: zoom to the chip's target cohort.
        fitMapToTargets(true);
      })
      .catch(function (err) {
        discoveryError = "Network error — try again.";
        discoveryResults = null;
        nodes.discoveryStatus.textContent = "";
        renderDossier();
        applyAllFilters();
      });
  }

  // spec-023i: client-side pipeline-chip handler. Filters projects[] for
  // dev rows (project_id starts wm_proj_future_dev_) and ranks by the
  // signal that matches the chip. Returns a result envelope shaped like
  // /api/discovery/query so renderTargetsList can render unchanged.
  function runPipelineChip(label) {
    const devs = (projects || []).filter(isDevProject);
    let scored = [];
    let summary = "";
    if (label === "High permit velocity") {
      // Score = count of recent (past-6-mo) filings. Filter requires ≥1.
      summary = "Pipeline · most permit activity in the past 6 months";
      scored = devs.map(function (p) {
        const filings = ((((p.facts || {}).dev_facts || {}).permits || {}).filings) || [];
        const recent = filings.filter(function (f) { return f.is_recent; });
        return { p: p, score: recent.length, filings: filings, recent: recent };
      })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; });
    } else if (label === "Near completion") {
      // Score = recency of late-stage work-type signals (plumbing, sprinkler,
      // mechanical, protection mechanical). The presence of these usually
      // means structural is done and interior systems are in flight.
      const LATE_KW = /plumbing|sprinkler|mechanical|protection/i;
      summary = "Pipeline · late-stage filings (plumbing/sprinkler/MEP) issued recently";
      scored = devs.map(function (p) {
        const filings = ((((p.facts || {}).dev_facts || {}).permits || {}).filings) || [];
        const lateRecent = filings.filter(function (f) {
          if (!f.is_recent) return false;
          const wts = (f.work_types || []).join(" ");
          return LATE_KW.test(wts) || LATE_KW.test(f.job_type || "");
        });
        return { p: p, score: lateRecent.length, filings: filings, lateRecent: lateRecent };
      })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; });
    } else if (label === "Newest finds") {
      // Score = most recent dev_facts.sources.last_updated date. Buildings
      // most recently article-discovered or refreshed by the hermes worker
      // bubble to the top.
      summary = "Pipeline · most recently article-discovered or refreshed";
      scored = devs.map(function (p) {
        const lu = (((p.facts || {}).dev_facts || {}).sources || {}).last_updated || "";
        // Sort key: ISO strings sort lexicographically. Pad missing values.
        return { p: p, score: lu, lu: lu };
      })
      .filter(function (x) { return x.score; })
      .sort(function (a, b) { return a.score < b.score ? 1 : a.score > b.score ? -1 : 0; });
    } else if (label === "Stalled projects") {
      // Stalled = ETA in the past AND stage doesn't show active-construction
      // language (excavation, foundation, superstructure, topped out, nearing
      // completion). Buildings whose original delivery date came and went
      // without the project moving into the construction phase. Score by
      // days-past-ETA — most-stuck first.
      const ACTIVE_CONSTRUCTION_KW = /superstructure|excavation|foundation|topped out|under construction|nearing completion|construction nearing|wrapping up/i;
      summary = "Pipeline · ETA passed but project hasn't reached active construction";
      const today = new Date();
      scored = devs.map(function (p) {
        const construction = ((p.facts || {}).dev_facts || {}).construction || {};
        const stage = (construction.stage || "").toLowerCase();
        const eta = construction.estimated_completion_date;
        if (!eta) return { p: p, score: 0, eta: null, daysPast: 0 };
        if (ACTIVE_CONSTRUCTION_KW.test(stage)) return { p: p, score: 0, eta: null, daysPast: 0 };
        const etaDate = new Date(eta);
        if (isNaN(etaDate.getTime()) || etaDate >= today) return { p: p, score: 0, eta: null, daysPast: 0 };
        const daysPast = Math.floor((today - etaDate) / 86400000);
        return { p: p, score: daysPast, eta: eta, daysPast: daysPast };
      })
      .filter(function (x) { return x.score > 0; })
      .sort(function (a, b) { return b.score - a.score; });
    }

    const top = scored.slice(0, 20).map(function (x) {
      const p = x.p;
      const dev = (p.facts && p.facts.dev_facts) || {};
      const construction = dev.construction || {};
      const team = dev.team || {};
      let punchy = "";
      if (label === "High permit velocity") {
        const recent = x.recent || [];
        const latest = recent[0] || {};
        punchy =
          "<strong>" + recent.length + " filings</strong> in past 6 mo · " +
          "latest <strong>" + escapeHtml(latest.filing_status || "") + "</strong> on " +
          escapeHtml(latest.current_status_date || latest.filing_date || "") +
          (team.developer_org ? " · " + escapeHtml(team.developer_org) : "");
      } else if (label === "Near completion") {
        const lateRecent = x.lateRecent || [];
        const latest = lateRecent[0] || {};
        const wt = (latest.work_types || []).join(", ");
        punchy =
          "<strong>" + escapeHtml(wt || latest.job_type || "Late-stage") + "</strong> " +
          escapeHtml(latest.filing_status || "") +
          " on " + escapeHtml(latest.current_status_date || "") +
          " · " + escapeHtml(construction.stage || "");
      } else if (label === "Newest finds") {
        punchy =
          "<strong>Refreshed " + escapeHtml((x.lu || "").slice(0, 10)) + "</strong> · " +
          escapeHtml(construction.stage || "") +
          (team.developer_org ? " · " + escapeHtml(team.developer_org) : "");
      } else if (label === "Stalled projects") {
        const yrs = x.daysPast >= 365 ? Math.floor(x.daysPast / 365) + "y" : x.daysPast + "d";
        punchy =
          "<strong>" + yrs + " past ETA</strong> · " +
          escapeHtml(construction.stage || "—") +
          (team.developer_org ? " · " + escapeHtml(team.developer_org) : "");
      }
      return {
        project_id: p.project_id,
        building_name: (p.map && p.map.project_name) || (p.facts && p.facts.project_name) || "",
        neighborhood: (p.map && p.map.neighborhood) || (p.list && p.list.neighborhood) || "",
        matching_signal: { punchy: punchy, kind: "pipeline_chip" },
      };
    });

    return {
      filter_summary: summary,
      result_count: top.length,
      results: top,
    };
  }

  // spec-023s: rental-side local chips. Pulls /api/buildings/weak-targets
  // at limit=200 (vs Haiku discovery API's top-20-by-score) and filters
  // client-side. Reuses weakTargetsRanked cache when set by the targets
  // overlay; otherwise fetches fresh.
  function runRentalLocalChip(label) {
    discoveryActive = true;
    discoveryError = null;
    discoveryResults = null;
    if (nodes.discoveryStatus) nodes.discoveryStatus.textContent = "Searching…";
    renderDossier();

    function applyChip(ranked) {
      let summary = "";
      let filtered = [];
      if (label === "Outside-rep buildings underperforming") {
        // Filter to outside_agent only via in-memory marketing_mode lookup.
        const modeByPid = new Map();
        (projects || []).forEach(function (p) {
          const mode = String((p.facts && p.facts.marketing_mode) || "unknown").toLowerCase();
          modeByPid.set(p.project_id, mode);
        });
        filtered = ranked.filter(function (r) {
          return modeByPid.get(r.project_id) === "outside_agent";
        }).slice(0, 20);
        summary = "Outside-rep rentals — slow to lease, extra vacancy, or asking under market";
      } else {
        filtered = ranked.slice(0, 20);
        summary = "Top weak rentals";
      }

      const results = filtered.map(function (r) {
        return {
          project_id: r.project_id,
          building_name: r.building_name,
          neighborhood: r.neighborhood,
          matching_signal: {
            punchy: _punchyLineFromWeakTarget(r),
            kind: "outside_rep_underperforming",
          },
        };
      });

      discoveryResults = {
        filter_summary: summary,
        result_count: results.length,
        results: results,
      };
      discoveryError = null;
      if (nodes.discoveryStatus) {
        nodes.discoveryStatus.textContent = "n=" + results.length;
      }
      renderDossier();
      // spec-025d: narrow the map lens to the chip's project_ids so the
      // map mirrors the right-rail Targets list.
      applyAllFilters();
      // spec-026: zoom to the chip's target cohort.
      fitMapToTargets(true);
    }

    if (weakTargetsRanked) {
      // Already cached by targets-overlay toggle — reuse.
      applyChip(weakTargetsRanked);
      return;
    }

    wmFetchWeakTargets(200)
      .then(function (data) {
        weakTargetsRanked = (data.results || []).slice();
        applyChip(weakTargetsRanked);
      })
      .catch(function (err) {
        discoveryError = "Couldn't load weak-targets pool — try again.";
        discoveryResults = null;
        if (nodes.discoveryStatus) nodes.discoveryStatus.textContent = "";
        renderDossier();
        applyAllFilters();
      });
  }

  function clearDiscovery() {
    discoveryActive = false;
    discoveryError = null;
    discoveryResults = null;
    targetsActiveResultIds = null;
    if (nodes.discoveryInput) nodes.discoveryInput.value = "";
    if (nodes.discoveryClear) nodes.discoveryClear.style.display = "none";
    if (nodes.discoveryChips) nodes.discoveryChips.style.display = "flex";
    if (nodes.discoveryStatus) nodes.discoveryStatus.textContent = "";
    renderDossier();
    // spec-025d: clearing discovery widens the lens back to the full
    // filter set; refresh markers + counts so the map releases the dim.
    applyAllFilters();
    // spec-026: restore the all-Manhattan fit so the user isn't left
    // zoomed-into the prior chip's cohort after they cleared it.
    fitMapToProjects(true);
  }

  // spec-025d: shared per-row punchy-line builder for any weak-target row
  // shaped like the /api/buildings/weak-targets response (has
  // dom_delta_days, avail_delta, price_delta_pct fields). Returns plain-
  // English signal lines in the same template used by the
  // "Outside-rep buildings underperforming" chip.
  function _punchyLineFromWeakTarget(r) {
    const dom = r.dom_delta_days || 0;
    const inv = r.avail_delta || 0;
    const price = r.price_delta_pct || 0;
    const lines = [];
    if (dom >= 14) lines.push("<strong>" + dom + " days</strong> slower to lease");
    else if (dom >= 7) lines.push(dom + " days slower to lease");
    if (inv >= 0.03) lines.push("<strong>" + Math.round(inv * 100) + " pp</strong> extra vacancy");
    else if (inv >= 0.02) lines.push(Math.round(inv * 100) + " pp extra vacancy");
    if (price <= -10) lines.push("asking <strong>" + Math.round(-price) + "% under market</strong>");
    else if (price <= -5) lines.push("asking " + Math.round(-price) + "% under market");
    return lines.length ? lines.join(" · ") : "Mild deltas across signals — fringe pitch.";
  }

  // spec-023r: filter raw chip results by marketing mode using the in-memory
  // projects[] map. Returns the sliced array per the active toggle:
  //   both        → top N in_house + top N outside_agent (interleaved by score)
  //   in_house    → top N in_house only
  //   outside_agent → top N outside_agent only
  function _sliceTargetsByMarketingMode(results) {
    if (!results || !results.length) return [];
    // Map every result's project_id to its marketing_mode via in-memory
    // projects[]. Results without a known mode bucket as 'unknown' and
    // appear under "both" but neither single-mode view.
    const modeByPid = new Map();
    (projects || []).forEach(function (p) {
      const mode = String((p.facts && p.facts.marketing_mode) || "unknown").toLowerCase();
      modeByPid.set(p.project_id, mode);
    });
    const inHouse = [];
    const outside = [];
    results.forEach(function (r) {
      const mode = modeByPid.get(r.project_id);
      if (mode === "in_house") inHouse.push(r);
      else if (mode === "outside_agent") outside.push(r);
    });
    if (targetsMarketingFilter === "in_house") {
      return inHouse.slice(0, TARGETS_LIST_LIMIT);
    }
    if (targetsMarketingFilter === "outside_agent") {
      return outside.slice(0, TARGETS_LIST_LIMIT);
    }
    // "both": top N each, in-house first then outside-agent
    return inHouse.slice(0, TARGETS_LIST_PER_MODE)
      .concat(outside.slice(0, TARGETS_LIST_PER_MODE));
  }

  function renderTargetsList(dossier) {
    dossier.innerHTML = "";
    const head = createEl("div", "v62-targets-head");
    head.appendChild(createEl("div", "v62-targets-title", "Targets"));
    if (discoveryError) {
      const err = createEl("div", "v62-targets-error",
        "Couldn't run that query — " + discoveryError);
      dossier.appendChild(head);
      dossier.appendChild(err);
      return;
    }
    if (!discoveryResults) {
      head.appendChild(createEl("div", "v62-targets-subtitle", "Searching…"));
      dossier.appendChild(head);
      return;
    }
    const summary = discoveryResults.filter_summary || "";
    const rawResults = (discoveryResults.results || []);
    const sliced = _sliceTargetsByMarketingMode(rawResults);

    head.appendChild(createEl("div", "v62-targets-subtitle",
      summary + " · n=" + sliced.length));

    // spec-023r: marketing-mode toggle — Both / In-house / Outside.
    // Lets the broker focus on outside-rep opportunities without the
    // in-house pool crowding the list (in-house outnumbers outside by
    // ~3x in raw weakness signals).
    const toggleWrap = createEl("div", "v62-targets-toggle");
    const toggleOptions = [
      ["both", "Both"],
      ["in_house", "In-house"],
      ["outside_agent", "Outside"],
    ];
    toggleOptions.forEach(function (opt) {
      const btn = createEl("button",
        "v62-targets-toggle-btn" + (targetsMarketingFilter === opt[0] ? " is-active" : ""),
        opt[1]);
      btn.type = "button";
      btn.addEventListener("click", function () {
        if (targetsMarketingFilter === opt[0]) return;
        targetsMarketingFilter = opt[0];
        renderTargetsList(dossier);
        // spec-025e: toggle change re-narrows the map lens too — the
        // visible markers should match the right-rail rows on every
        // toggle click, not only on chip click.
        applyAllFilters();
        // spec-026: refit the map to the now-narrower toggle slice.
        fitMapToTargets(true);
      });
      toggleWrap.appendChild(btn);
    });
    head.appendChild(toggleWrap);
    dossier.appendChild(head);

    // spec-025d/f: refresh the active-results-id Set so the map lens
    // narrows to whatever the toggle is currently showing.
    targetsActiveResultIds = new Set();
    sliced.forEach(function (r) { if (r && r.project_id) targetsActiveResultIds.add(r.project_id); });

    if (!sliced.length) {
      const empty = createEl("div", "v62-targets-empty",
        targetsMarketingFilter === "both"
          ? "No buildings match — try broadening, or click a chip above."
          : "No " + (targetsMarketingFilter === "in_house" ? "in-house" : "outside-rep")
            + " buildings match this chip — try broadening.");
      dossier.appendChild(empty);
      return;
    }
    const list = createEl("div", "v62-targets-list");
    sliced.forEach(function (r) {
      const row = createEl("button", "v62-target-row");
      row.type = "button";
      row.appendChild(createEl("div", "v62-target-name", r.building_name || "(unnamed)"));
      row.appendChild(createEl("div", "v62-target-nb", r.neighborhood || ""));
      const sig = (r.matching_signal || {});
      // Punchy line is server-controlled HTML so we can bold the
      // brokerage jab + reserved-pool catchphrases via <strong> tags.
      // The string is composed entirely from validated SQL data and
      // curated templates — safe to render as innerHTML.
      const punchy = createEl("div", "v62-target-punchy" +
        (sig.intensity === "extreme" ? " is-extreme" : ""));
      punchy.innerHTML = sig.punchy || "";
      row.appendChild(punchy);
      row.addEventListener("click", function () {
        // Click → close discovery and load the standard dossier for this building.
        if (r.project_id) selectProjectByProjectId(r.project_id);
      });
      list.appendChild(row);
    });
    dossier.appendChild(list);
  }

  // Helper: open the standard dossier for a project_id (used by target click).
  function selectProjectByProjectId(projectId) {
    // Look up via the in-memory payload index used elsewhere in the app.
    const proj = (projects || []).find(function (p) { return p.project_id === projectId; });
    if (!proj) return;
    discoveryActive = false;
    if (nodes.discoveryInput) nodes.discoveryInput.value = "";
    if (nodes.discoveryClear) nodes.discoveryClear.style.display = "none";
    if (nodes.discoveryChips) nodes.discoveryChips.style.display = "flex";
    if (nodes.discoveryStatus) nodes.discoveryStatus.textContent = "";
    // The app's selection variable is `selectedId` (set by lens-rail clicks
    // and map-marker clicks); update it directly so getSelectedProject()
    // returns the right building.
    selectedId = projectId;
    renderDossier();
    // Re-render the lens / map highlights too so the rest of the UI agrees.
    if (typeof applyAllFilters === "function") applyAllFilters();
  }

  function kpiNode(label, value, warm) {
    const btn = createEl("button", "v62-kpi" + (warm ? " is-warm" : ""));
    btn.type = "button";
    btn.disabled = true;
    const tipMap = {
      "prio a": "A-tier targets in view",
      "dm": "Decision makers known / total",
      "fub": "Linked to Follow Up Boss / total",
      "due": "Follow-ups due or overdue"
    };
    btn.title = tipMap[String(label).toLowerCase()] || "Filter not wired in this static pilot";
    btn.appendChild(createEl("span", "v62-kpi-label", label));
    const val = createEl("span", "v62-kpi-value", value);
    btn.appendChild(val);
    btn._valueNode = val;
    return btn;
  }

  function buildLensRail(root) {
    const head = createEl("div", "v62-lens-head");

    const headRow = createEl("div", "v62-lens-head-row");
    const headLeft = createEl("div");
    headLeft.appendChild(createEl("div", "v62-lens-kicker", "Lens"));
    const countLine = createEl("div", "v62-lens-count");
    nodes.lensCountBig = createEl("span", "big", String(projects.length));
    countLine.appendChild(nodes.lensCountBig);
    // spec-023i: keep a ref to the "of N" denominator so it updates when
    // filters change (e.g. selecting "Under construction" reduces the
    // pool from 1072 to 132).
    nodes.lensCountOf = createEl("span", "of", "of " + projects.length + " in lens");
    countLine.appendChild(nodes.lensCountOf);
    headLeft.appendChild(countLine);
    headRow.appendChild(headLeft);
    const resetBtn = createEl("button", "v62-lens-reset", "Reset");
    resetBtn.type = "button";
    resetBtn.disabled = true;
    resetBtn.title = "Reset not wired in pilot";
    headRow.appendChild(resetBtn);
    head.appendChild(headRow);

    const search = createEl("div", "v62-lens-search");
    const searchIcon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    searchIcon.setAttribute("viewBox", "0 0 16 16");
    searchIcon.setAttribute("width", "11");
    searchIcon.setAttribute("height", "11");
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", "7"); c.setAttribute("cy", "7"); c.setAttribute("r", "4.5");
    c.setAttribute("fill", "none"); c.setAttribute("stroke", "#5b5b56"); c.setAttribute("stroke-width", "1");
    searchIcon.appendChild(c);
    const l = document.createElementNS("http://www.w3.org/2000/svg", "line");
    l.setAttribute("x1", "10.5"); l.setAttribute("y1", "10.5"); l.setAttribute("x2", "14"); l.setAttribute("y2", "14");
    l.setAttribute("stroke", "#5b5b56"); l.setAttribute("stroke-width", "1"); l.setAttribute("stroke-linecap", "round");
    searchIcon.appendChild(l);
    search.appendChild(searchIcon);
    const input = createEl("input");
    input.type = "text";
    input.placeholder = "Address, project, sponsor, listing agent…";
    input.title = "Search across name, address, neighborhood, sponsors, operators, marketers, listing agents";
    input.value = searchFilter;
    input.addEventListener("input", function () {
      const next = input.value.trim().toLowerCase();
      if (searchDebounceId) clearTimeout(searchDebounceId);
      searchDebounceId = setTimeout(function () {
        if (next === searchFilter) return;
        searchFilter = next;
        applyAllFilters();
      }, 150);
    });
    search.appendChild(input);
    search.style.opacity = "1";
    head.appendChild(search);

    root.appendChild(head);

    const bodyEl = createEl("div", "v62-lens-body");

    // Workflow flags block
    const flagBlock = createEl("div", "v62-flagblock");
    const flagHead = createEl("div", "v62-flagblock-head");
    flagHead.appendChild(createEl("div", "v62-flagblock-title", "Workflow flags"));
    flagBlock.appendChild(flagHead);
    flagBlock.appendChild(quickToggle(
      "Decision maker",
      [["any","Any"],["known","Known"],["unknown","Unknown"]],
      dmFilter,
      function (val) { dmFilter = val; applyAllFilters(); }
    ));
    flagBlock.appendChild(quickToggle("Follow Up Boss", [["any","Any"],["linked","Linked"],["unlinked","Unlinked"]], "any"));
    flagBlock.appendChild(liveMarketingToggle());
    const checkRow = createEl("label", "v62-quick-check");
    checkRow.appendChild(createEl("span", "box"));
    checkRow.appendChild(createEl("span", "", "Follow-up due or overdue"));
    flagBlock.appendChild(checkRow);
    bodyEl.appendChild(flagBlock);

    // Groups
    const groups = [
      { label: "Qualification", sections: [
        { key: "rank", label: "Rank", meta: "All" },
        { key: "pipeline_status", label: "Pipeline status", meta: "All" },
      ]},
      { label: "Inventory", sections: [
        { key: "building_status", label: "Building status", meta: "All" },
        { key: "size", label: "Size", meta: "All" },
        { key: "residential_type", label: "Residential type", meta: "All" },
      ]},
    ];
    nodes.lensSectionMeta = {};
    groups.forEach(function (g) {
      bodyEl.appendChild(createEl("div", "v62-group-header", g.label));
      g.sections.forEach(function (s) {
        const section = createEl("div", "v62-lens-section");
        const row = createEl("div", "v62-lens-section-row");
        const btn = createEl("button", "v62-lens-section-btn");
        btn.type = "button";
        btn.appendChild(createEl("span", "v62-lens-section-label", s.label));
        const meta = createEl("span", "v62-lens-section-meta");
        const metaText = document.createTextNode(s.meta);
        meta.appendChild(metaText);
        meta.appendChild(createEl("span", "caret", "›"));
        btn.appendChild(meta);
        row.appendChild(btn);
        section.appendChild(row);
        bodyEl.appendChild(section);
        nodes.lensSectionMeta[s.key] = metaText;

        if (s.key === "building_status") {
          btn.title = "Filter by building status (multi-select)";
          mountCheckboxPopdown(btn, section, BUILDING_STATUS_OPTIONS, buildingStatusSelected, applyAllFilters);
        } else if (s.key === "size") {
          btn.title = "Filter by size (multi-select)";
          mountCheckboxPopdown(btn, section, SIZE_OPTIONS, sizeSelected, applyAllFilters);
        } else if (s.key === "residential_type") {
          btn.title = "Filter by residential type (multi-select)";
          mountCheckboxPopdown(btn, section, RESIDENTIAL_TYPE_OPTIONS, residentialTypeSelected, applyAllFilters);
        } else {
          btn.disabled = true;
          btn.title = "Filter section not wired in pilot";
        }
      });
    });

    root.appendChild(bodyEl);

    const footer = createEl("div", "v62-lens-footer");
    const exportBtn = createEl("button", "v62-lens-export");
    exportBtn.type = "button";
    exportBtn.disabled = true;
    exportBtn.title = "Export not wired in pilot";
    exportBtn.appendChild(createEl("span", "", "Export set · CSV"));
    nodes.exportCount = createEl("span", "", String(projects.length));
    exportBtn.appendChild(nodes.exportCount);
    footer.appendChild(exportBtn);
    root.appendChild(footer);
  }

  function liveMarketingToggle() {
    const wrap = createEl("div", "v62-quick");
    wrap.appendChild(createEl("div", "v62-quick-label", "Marketing"));
    const seg = createEl("div", "v62-quick-seg");
    const options = [
      ["any", "Any"],
      ["in_house", "In-house"],
      ["outside_agent", "Outside"],
      ["unknown", "Unknown"],
      ["not_marketed_yet", "Not yet"],
    ];
    const buttons = [];
    options.forEach(function (opt) {
      const b = createEl("button", opt[0] === marketingFilter ? "is-active" : "");
      b.type = "button";
      b.textContent = opt[1];
      b.title = "Filter by marketing mode (in_house / outside_agent / unknown)";
      b.addEventListener("click", function () {
        if (marketingFilter === opt[0]) return;
        marketingFilter = opt[0];
        buttons.forEach(function (other, i) {
          other.classList.toggle("is-active", options[i][0] === marketingFilter);
        });
        applyMarketingFilter();
      });
      buttons.push(b);
      seg.appendChild(b);
    });
    wrap.appendChild(seg);
    return wrap;
  }

  function projectMatchesMarketing(project) {
    if (marketingFilter === "any") return true;
    return classifyLeasingMode(project) === marketingFilter;
  }

  function projectMatchesBuildingStatus(project) {
    if (buildingStatusSelected.size === 0) return true;
    const s = String(
      project.list.canonical_status ||
      project.facts.canonical_status ||
      project.map.canonical_status ||
      ""
    ).toLowerCase();
    return buildingStatusSelected.has(s);
  }

  function projectMatchesSearch(project) {
    if (!searchFilter) return true;
    const indexed = searchIndex.get(project.project_id) || "";
    return indexed.indexOf(searchFilter) !== -1;
  }

  function projectMatchesSize(project) {
    if (sizeSelected.size === 0) return true;
    const unit = project.list && project.list.unit_count;
    const bucket = sizeBucket(unit != null ? unit : (project.facts && project.facts.unit_count));
    return bucket != null && sizeSelected.has(bucket);
  }

  function projectMatchesResidentialType(project) {
    if (residentialTypeSelected.size === 0) return true;
    const t = String(
      (project.list && project.list.residential_type) ||
      (project.facts && project.facts.residential_type) ||
      ""
    ).toLowerCase();
    return residentialTypeSelected.has(t);
  }

  function projectMatchesDecisionMaker(project) {
    if (dmFilter === "any") return true;
    const raw = String((project.workflow && project.workflow.decision_maker_status) || "").toLowerCase();
    // Per schema §8.9: known = a DM is named; unknown covers both "unknown"
    // and missing/empty.
    const status = raw === "known" ? "known" : "unknown";
    return status === dmFilter;
  }

  function projectPassesAllFilters(project) {
    return projectMatchesMarketing(project)
      && projectMatchesBuildingStatus(project)
      && projectMatchesSearch(project)
      && projectMatchesSize(project)
      && projectMatchesResidentialType(project)
      && projectMatchesDecisionMaker(project);
  }

  // Kept as the wired-marketing-toggle entry point; delegates to applyAllFilters now.
  // spec-023m: when targets overlay is active, the yellow set is sliced
  // per marketing mode — recompute it whenever the marketing pill changes
  // so the visible yellow markers refresh live (top 20 in-house ↔ top 20
  // outside-agent ↔ both).
  function applyMarketingFilter() {
    if (targetsOverlayActive && weakTargetsRanked) {
      recomputeWeakTargetIds();
    }
    applyAllFilters();
  }

  function applyAllFilters() {
    let visible = 0;
    const selected = getSelectedProject();
    mappableProjects.forEach(function (p) {
      const marker = markerById.get(p.project_id);
      if (!marker) return;
      // spec-023n: count uses the same predicate the mast/lens use, so
      // the export-count chip in the right rail also drops to the
      // overlay-narrowed set when targets mode is on.
      if (projectIsInLens(p)) visible++;
      // Re-bake the icon so the is-mk-hidden class is part of the icon HTML.
      // This persists across Leaflet's own zoom/pan re-renders.
      marker.setIcon(buildMarkerIcon(p, {
        selected: Boolean(selected && selected.project_id === p.project_id),
        hovered: hoveredId === p.project_id,
        muted: Boolean(hoveredId && selected && hoveredId !== p.project_id && selected.project_id !== p.project_id)
      }));
    });
    if (nodes.exportCount) {
      nodes.exportCount.textContent = String(visible);
    }
    refreshLensSectionMeta();
    // spec-023i: refresh the lens header count too so the "of N" reflects
    // the active filter set (was previously stuck at the all-projects total).
    updateLensCountFromViewport();
    // spec-023i pt 2: same bug existed for the masthead "IN LENS / PRIO A /
    // DM / FUB / DUE" counters (top of page). renderWorldHeader's scope now
    // respects projectPassesAllFilters; call it here so the masthead refreshes
    // on every filter change, not just on map move/zoom.
    renderWorldHeader();
  }

  function summarizeMultiSelect(selectedSet, shortLabels, allLabel, total, scope, fallbackProbe) {
    if (selectedSet.size === 0) {
      // No filter active. Probe the visible scope to give a useful auto-label.
      const seen = new Set();
      if (typeof fallbackProbe === "function") {
        scope.forEach(function (p) {
          const v = fallbackProbe(p);
          if (v) seen.add(v);
        });
      }
      if (seen.size === 1) {
        const only = seen.values().next().value;
        return (shortLabels[only] || titleCaseToken(only)) + " (" + total + ")";
      }
      if (seen.size === 0) return allLabel + " (" + total + ")";
      return allLabel + " (" + total + ")";
    }
    if (selectedSet.size === 1) {
      const only = selectedSet.values().next().value;
      return (shortLabels[only] || titleCaseToken(only)) + " (" + total + ")";
    }
    if (selectedSet.size <= 3) {
      const labels = Array.from(selectedSet).map(function (v) {
        return shortLabels[v] || titleCaseToken(v);
      });
      return labels.join(", ") + " (" + total + ")";
    }
    return selectedSet.size + " selected (" + total + ")";
  }

  function refreshLensSectionMeta() {
    if (!nodes.lensSectionMeta) return;
    const scope = projects.filter(projectPassesAllFilters);
    const total = scope.length;

    const buildingMeta = nodes.lensSectionMeta.building_status;
    if (buildingMeta) {
      buildingMeta.textContent = summarizeMultiSelect(
        buildingStatusSelected, BUILDING_STATUS_SHORT, "All", total, scope,
        function (p) {
          return String(p.list.canonical_status || p.facts.canonical_status || p.map.canonical_status || "").toLowerCase();
        }
      );
    }

    const sizeMeta = nodes.lensSectionMeta.size;
    if (sizeMeta) {
      sizeMeta.textContent = summarizeMultiSelect(
        sizeSelected, SIZE_SHORT, "All sizes", total, scope, null
      );
    }

    const typeMeta = nodes.lensSectionMeta.residential_type;
    if (typeMeta) {
      typeMeta.textContent = summarizeMultiSelect(
        residentialTypeSelected, RESIDENTIAL_TYPE_SHORT, "All types", total, scope,
        function (p) {
          return String((p.list && p.list.residential_type) || (p.facts && p.facts.residential_type) || "").toLowerCase();
        }
      );
    }
  }

  function mountCheckboxPopdown(btn, anchor, options, selectedSet, onChange) {
    // Multi-select popdown anchored under the lens-section row. Click the
    // section button to toggle the popdown; check/uncheck items to update
    // the filter live; click outside (or the section button again) to close.
    let popdown = null;
    let outsideHandler = null;

    function close() {
      if (popdown) {
        popdown.remove();
        popdown = null;
      }
      if (outsideHandler) {
        document.removeEventListener("mousedown", outsideHandler, true);
        outsideHandler = null;
      }
      btn.classList.remove("is-open");
    }

    function open() {
      popdown = createEl("div", "lens-popdown");
      options.forEach(function (opt) {
        const row = createEl("label", "lens-popdown-row");
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = selectedSet.has(opt.value);
        cb.addEventListener("change", function () {
          if (cb.checked) selectedSet.add(opt.value);
          else selectedSet.delete(opt.value);
          onChange();
        });
        row.appendChild(cb);
        row.appendChild(createEl("span", "lens-popdown-row-label", opt.label));
        popdown.appendChild(row);
      });
      const clearBtn = createEl("button", "lens-popdown-clear", "Clear");
      clearBtn.type = "button";
      clearBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (selectedSet.size === 0) return;
        selectedSet.clear();
        popdown.querySelectorAll("input[type=checkbox]").forEach(function (cb) {
          cb.checked = false;
        });
        onChange();
      });
      popdown.appendChild(clearBtn);
      anchor.appendChild(popdown);
      btn.classList.add("is-open");
      // capture-phase mousedown so outside clicks close even if a child
      // stops propagation in its own listener.
      outsideHandler = function (e) {
        if (popdown && !popdown.contains(e.target) && !btn.contains(e.target)) {
          close();
        }
      };
      document.addEventListener("mousedown", outsideHandler, true);
    }

    btn.addEventListener("click", function (e) {
      e.preventDefault();
      if (popdown) close();
      else open();
    });
  }

  function quickToggle(label, options, active, onPick) {
    // When onPick is provided, buttons are live and call onPick(value) on
    // click; the seg flips its is-active class so the segmented control
    // reflects the new state. When onPick is omitted, falls back to the
    // legacy disabled-stub presentation.
    const wrap = createEl("div", "v62-quick");
    wrap.appendChild(createEl("div", "v62-quick-label", label));
    const seg = createEl("div", "v62-quick-seg");
    const buttons = [];
    options.forEach(function (opt) {
      const b = createEl("button", opt[0] === active ? "is-active" : "");
      b.type = "button";
      b.textContent = opt[1];
      b._optionValue = opt[0];
      if (onPick) {
        b.title = label + " · " + opt[1];
        b.addEventListener("click", function () {
          buttons.forEach(function (other) {
            other.classList.toggle("is-active", other === b);
          });
          onPick(opt[0]);
        });
      } else {
        b.disabled = true;
        b.title = "Filter not wired in pilot";
      }
      seg.appendChild(b);
      buttons.push(b);
    });
    wrap.appendChild(seg);
    return wrap;
  }

  // spec-025g: re-fit the map to the bounding box of every mappable project.
  // Used by initMap (animate=false on first render) and the Recenter button
  // (animate=true so the snap-back has visible motion).
  function fitMapToProjects(animate) {
    if (!map || !mappableProjects || !mappableProjects.length) return;
    const bounds = leaflet.latLngBounds(mappableProjects.map(function (project) {
      return [project.latitude, project.longitude];
    }));
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.32), {
        animate: Boolean(animate),
        padding: [38, 38],
      });
    }
  }

  // spec-026: re-fit the map to the bounding box of the active chip's
  // target IDs. Sibling to fitMapToProjects(); reads from the
  // targetsActiveResultIds Set that renderTargetsList refreshes on every
  // call (per spec-025e). No-op when no chip is active or the cohort
  // is empty — keeps the map view stable in those states.
  function fitMapToTargets(animate) {
    if (!map || !targetsActiveResultIds || !targetsActiveResultIds.size) return;
    const bounds = leaflet.latLngBounds([]);
    mappableProjects.forEach(function (p) {
      if (targetsActiveResultIds.has(p.project_id)) {
        bounds.extend([p.latitude, p.longitude]);
      }
    });
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.32), {
        animate: Boolean(animate),
        padding: [38, 38],
        // Cap zoom so a single-result fit doesn't drop us to street level.
        maxZoom: 16,
      });
    }
  }

  function initMap() {
    if (!mappableProjects.length) {
      nodes.mapEmpty.hidden = false;
      nodes.mapEmpty.textContent = "No valid geographic coordinates are available in the current payload.";
      return;
    }

    map = leaflet.map(nodes.mapCanvas, {
      zoomControl: false,
      attributionControl: true,
      scrollWheelZoom: true,
      doubleClickZoom: true,
      boxZoom: false,
      preferCanvas: false
    });

    leaflet.control.zoom({
      position: "bottomright"
    }).addTo(map);

    leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    mappableProjects.forEach(function (project) {
      const rankOffset = computeRankZ(project);
      const marker = leaflet.marker([project.latitude, project.longitude], {
        icon: buildMarkerIcon(project, {
          selected: false,
          hovered: false,
          muted: false
        }),
        title: text(project.list.project_name || project.map.project_name),
        keyboard: true,
        riseOnHover: true
      });

      marker.bindTooltip("", {
        direction: "right",
        offset: [18, -14],
        className: "project-tooltip-shell",
        opacity: 1,
        permanent: false
      });

      marker.on("click", function () {
        setSelected(project.project_id);
      });

      marker.on("mouseover", function () {
        setHovered(project.project_id);
      });

      marker.on("mouseout", function () {
        setHovered(null);
      });

      marker.on("focus", function () {
        setHovered(project.project_id);
      });

      marker.on("blur", function () {
        if (hoveredId === project.project_id) {
          setHovered(null);
        }
      });

      marker.addTo(map);
      marker.setZIndexOffset(rankOffset);
      markerById.set(project.project_id, marker);
    });

    fitMapToProjects(false);

    window.addEventListener("resize", function () {
      if (map) {
        map.invalidateSize(false);
      }
    });

    // Lens count + top-bar chips reflect visible viewport
    map.on("moveend zoomend", function () {
      updateLensCountFromViewport();
      renderWorldHeader();
    });
    requestAnimationFrame(updateLensCountFromViewport);

    requestAnimationFrame(function () {
      if (map) {
        map.invalidateSize(false);
      }
    });

    // Apply timeline filter once markers are in the DOM
    if (nodes.applyTimeline) {
      requestAnimationFrame(function () {
        nodes.applyTimeline();
      });
    }
  }

  // spec-023n: shared visibility predicate. A project is "in lens" when it
  // passes the active filter pills AND, when the targets overlay is on,
  // is actually highlighted yellow. Without this, count displays show the
  // full filter pool even when overlay narrows the visible markers to ~40.
  // spec-025d/e: when a discovery chip / query is active, the lens narrows
  // to whatever is actually visible in the right-rail Targets list — the
  // chip slice, the toggle slice, OR the fallback slice. We read from
  // targetsActiveResultIds (refreshed on every renderTargetsList) so
  // toggling Both / In-house / Outside updates the map markers in lockstep.
  function getDiscoveryResultIdSet() {
    if (!discoveryActive) return null;
    if (targetsActiveResultIds && targetsActiveResultIds.size) {
      return targetsActiveResultIds;
    }
    // Fallback: before renderTargetsList has run (e.g. during the very
    // first render), use the raw discoveryResults set.
    if (!discoveryResults || !Array.isArray(discoveryResults.results)) {
      return null;
    }
    const ids = new Set();
    discoveryResults.results.forEach(function (r) {
      if (r && r.project_id) ids.add(r.project_id);
    });
    return ids;
  }
  function projectIsInLens(p) {
    if (!projectPassesAllFilters(p)) return false;
    if (targetsOverlayActive && !isTargetHighlighted(p)) return false;
    const discoveryIds = getDiscoveryResultIdSet();
    if (discoveryIds && discoveryIds.size && !discoveryIds.has(p.project_id)) return false;
    return true;
  }

  function updateLensCountFromViewport() {
    if (!map || !nodes.lensCountBig) return;
    const bounds = map.getBounds();
    let visible = 0;       // in lens AND in viewport
    let inFilters = 0;     // in lens (regardless of viewport)
    mappableProjects.forEach(function (p) {
      if (!projectIsInLens(p)) return;
      inFilters += 1;
      if (bounds.contains([p.latitude, p.longitude])) visible += 1;
    });
    nodes.lensCountBig.textContent = String(visible);
    if (nodes.lensCountOf) {
      nodes.lensCountOf.textContent = "of " + inFilters + " in lens";
    }
  }

  // spec-023j/m: targets overlay — fetch a deep pool of weak rentals (top 200)
  // and slice top-N per marketing mode based on the active left-rail pill.
  // Recomputes weakTargetIds whenever the marketing pill changes so toggling
  // pills live-updates the yellow set.
  function recomputeWeakTargetIds() {
    if (!weakTargetsRanked) {
      weakTargetIds = new Set();
      return;
    }
    // Map every weak project_id to its marketing_mode via in-memory projects[].
    const modeByPid = new Map();
    (projects || []).forEach(function (p) {
      const mode = String((p.facts && p.facts.marketing_mode) || "unknown").toLowerCase();
      modeByPid.set(p.project_id, mode);
    });
    const filter = String(marketingFilter || "any").toLowerCase();
    const ids = new Set();
    if (filter === "any") {
      // Show top-N from each of the meaningful pitch buckets so neither set
      // crowds the other out (the in-house pool is much larger than outside).
      const buckets = ["in_house", "outside_agent"];
      buckets.forEach(function (mode) {
        let taken = 0;
        for (let i = 0; i < weakTargetsRanked.length && taken < TARGETS_PER_MODE; i++) {
          const r = weakTargetsRanked[i];
          if (modeByPid.get(r.project_id) === mode) {
            ids.add(r.project_id);
            taken += 1;
          }
        }
      });
    } else if (filter === "not_marketed_yet") {
      // Pipeline buildings have no weakness signal — empty set.
    } else {
      // Specific marketing mode pill (in_house / outside_agent / unknown).
      let taken = 0;
      for (let i = 0; i < weakTargetsRanked.length && taken < TARGETS_PER_MODE; i++) {
        const r = weakTargetsRanked[i];
        if (modeByPid.get(r.project_id) === filter) {
          ids.add(r.project_id);
          taken += 1;
        }
      }
    }
    weakTargetIds = ids;
  }

  // Sentinel used to identify a discoveryResults envelope that was set by
  // the TARGETS mode toggle (vs. a real discovery chip). Lets us clear our
  // own state on toggle-off without trampling user-driven chip results.
  const _TARGETS_OVERLAY_SUMMARY = "All weak targets";

  function _populateDossierFromTargets() {
    // Mirrors runRentalLocalChip's shape: adapts wmFetchWeakTargets rows
    // into the discoveryResults envelope that renderTargetsList consumes.
    const ranked = weakTargetsRanked || [];
    const results = ranked.map(function (r) {
      return {
        project_id: r.project_id,
        building_name: r.building_name,
        neighborhood: r.neighborhood,
        matching_signal: {
          punchy: _punchyLineFromWeakTarget(r),
          kind: "targets_overlay",
        },
      };
    });
    discoveryActive = true;
    discoveryError = null;
    discoveryResults = {
      filter_summary: _TARGETS_OVERLAY_SUMMARY,
      result_count: results.length,
      results: results,
    };
    if (nodes.discoveryStatus) {
      nodes.discoveryStatus.textContent = "n=" + results.length;
    }
    renderDossier();
  }

  function setTargetsOverlay(active) {
    if (active === targetsOverlayActive) return;
    targetsOverlayActive = active;
    // Update mode-button visual state
    if (nodes.modeButtons) {
      if (nodes.modeButtons.World) {
        nodes.modeButtons.World.classList.toggle("is-active", !active);
      }
      if (nodes.modeButtons.Targets) {
        nodes.modeButtons.Targets.classList.toggle("is-active", active);
      }
    }

    // spec-027c: TARGETS mode should ALSO populate the dossier with the
    // weak-targets list (previously the button only highlighted markers and
    // left the dossier untouched, which felt broken to users). We reuse the
    // discoveryResults envelope so renderTargetsList — already wired with
    // marketing-mode toggle, map-lens narrowing, etc. — handles everything.
    if (!active) {
      // Only clear if it was us that populated it (don't trample a real chip).
      if (discoveryActive
          && discoveryResults
          && discoveryResults.filter_summary === _TARGETS_OVERLAY_SUMMARY) {
        discoveryActive = false;
        discoveryResults = null;
        discoveryError = null;
        if (nodes.discoveryStatus) nodes.discoveryStatus.textContent = "";
      }
      renderDossier();
      if (typeof applyAllFilters === "function") applyAllFilters();
      return;
    }

    // active = true
    if (weakTargetsRanked === null && !weakTargetLoading) {
      weakTargetLoading = true;
      // Optimistic UX: show the "Searching…" state in the dossier while the
      // fetch is in flight. renderTargetsList renders that state when
      // discoveryActive && !discoveryResults && !discoveryError.
      discoveryActive = true;
      discoveryResults = null;
      discoveryError = null;
      if (nodes.discoveryStatus) {
        nodes.discoveryStatus.textContent = "Searching…";
      }
      renderDossier();
      wmFetchWeakTargets(200)
        .then(function (data) {
          weakTargetsRanked = (data.results || []).slice();
          weakTargetLoading = false;
          recomputeWeakTargetIds();
          _populateDossierFromTargets();
          if (typeof applyAllFilters === "function") applyAllFilters();
        })
        .catch(function (err) {
          weakTargetLoading = false;
          weakTargetsRanked = [];
          weakTargetIds = new Set();
          console.warn("targets overlay fetch failed:", err);
          discoveryError = "Couldn't load weak-targets pool — try again.";
          discoveryResults = null;
          if (nodes.discoveryStatus) nodes.discoveryStatus.textContent = "";
          renderDossier();
          if (typeof applyAllFilters === "function") applyAllFilters();
        });
      // Optimistic re-render of markers (highlight will appear once the
      // recompute lands).
      if (typeof applyAllFilters === "function") applyAllFilters();
    } else {
      // Pool already loaded — recompute (marketing pill may have changed)
      // and surface the dossier list synchronously.
      recomputeWeakTargetIds();
      _populateDossierFromTargets();
      if (typeof applyAllFilters === "function") applyAllFilters();
    }
  }

  function isTargetHighlighted(project) {
    if (!targetsOverlayActive) return false;
    if (!weakTargetIds) return false;
    return weakTargetIds.has(project.project_id);
  }

  function computeRankZ(project) {
    // Higher priority → higher z-offset so it paints above lower-ranked overlaps.
    // priority_score is typically 1..100; pipeline rank can be 1..N (lower is better).
    const pri = Number(project.workflow && project.workflow.priority_score);
    if (Number.isFinite(pri) && pri > 0) {
      return Math.round(pri * 2); // 0..200
    }
    const rank = Number(project.workflow && project.workflow.pipeline_rank);
    if (Number.isFinite(rank) && rank > 0) {
      return Math.max(0, 300 - rank * 3); // rank 1 → 297, rank 2 → 294 ...
    }
    return 0;
  }

  // Normalize org name for brand-family matching: drop common suffixes,
  // lowercase, keep first two significant tokens.
  function orgBrandKey(name) {
    if (!name) return "";
    const noise = /\b(properties|rentals|communities|platform|companies|company|group|llc|inc|corp|corporation|holdings|partners|management|capital|realty|development|residential|apartments|co)\b/gi;
    const cleaned = String(name).toLowerCase().replace(noise, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
    return cleaned.split(" ").filter(Boolean).slice(0, 2).join(" ");
  }

  function sameBrandFamily(a, b) {
    const ak = orgBrandKey(a);
    const bk = orgBrandKey(b);
    if (!ak || !bk) return false;
    if (ak === bk) return true;
    // share the first token (e.g. "related" vs "related rental" post-noise-strip)
    const aFirst = ak.split(" ")[0];
    const bFirst = bk.split(" ")[0];
    return Boolean(aFirst && aFirst === bFirst);
  }

  function classifyLeasingMode(project) {
    // Prefer the canonical, transform-set field (driven by the CSV's `bucket`
    // column via world-model/transforms/doorman_to_payload.py). Fall back to
    // name-match heuristics only when the canonical field is absent.
    const canonical = String((project.facts && project.facts.marketing_mode) || "").toLowerCase();
    if (canonical === "in_house" || canonical === "outside_agent" || canonical === "unknown" || canonical === "not_marketed_yet") {
      return canonical;
    }
    if (canonical === "outside_broker") return "outside_agent"; // legacy alias

    const marketers = (project.organizations && project.organizations.marketers) || [];
    const operators = (project.organizations && project.organizations.operators) || [];
    const sponsors = (project.organizations && project.organizations.sponsors) || [];
    const mNames = marketers.map(function (o) { return typeof o === "string" ? o : (o && o.org_name) || ""; }).filter(Boolean);
    const opNames = operators.map(function (o) { return typeof o === "string" ? o : (o && o.org_name) || ""; }).filter(Boolean);
    const spNames = sponsors.map(function (o) { return typeof o === "string" ? o : (o && o.org_name) || ""; }).filter(Boolean);

    if (!mNames.length && !opNames.length && !spNames.length) return "unknown";
    if (!mNames.length) return "in_house"; // no broker posted → operator handles leasing
    // Any marketer that matches an operator or sponsor family counts as in-house.
    const inHouse = mNames.some(function (m) {
      return opNames.some(function (op) { return sameBrandFamily(m, op); })
          || spNames.some(function (sp) { return sameBrandFamily(m, sp); });
    });
    if (inHouse) return "in_house";
    return "outside_agent";
  }

  function buildMarkerIcon(project, state) {
    const width = state.selected ? 18 : 14;
    const depth = state.selected ? 11 : 8;
    const height = scaleStory(project.stories, state.selected);
    const iconWidth = width + depth + 16;
    const iconHeight = height + depth + 18;
    const classes = ["project-marker"];
    const leasingMode = classifyLeasingMode(project);
    // Both class names render the same in CSS (alias rules added below). Tag both
    // so we can data-attribute the marker and target via the marketing filter.
    if (leasingMode === "outside_agent") {
      classes.push("is-lease-outside-broker", "is-lease-outside-agent");
    } else {
      classes.push("is-lease-" + leasingMode.replace("_", "-"));
    }
    // Bake the active filter state into the icon HTML so Leaflet's own marker
    // re-render (on zoom/pan) preserves the hidden state. Without this, classes
    // toggled directly on .project-marker dropped off after every zoom.
    const passesFilters = projectPassesAllFilters(project);
    // spec-023j: when targets overlay is on, the only markers visible are
    // weak rentals (top 10% by score). Non-weak markers get hidden; weak
    // ones get the yellow highlight class.
    const overlayActive = targetsOverlayActive;
    const isTarget = isTargetHighlighted(project);
    const filteredOut = !passesFilters || (overlayActive && !isTarget);
    if (filteredOut) {
      classes.push("is-mk-hidden");
    }
    if (overlayActive && isTarget) {
      classes.push("is-target-highlight");
    }

    if (state.selected) {
      classes.push("is-selected");
    } else if (state.hovered) {
      classes.push("is-hovered");
    }

    if (state.muted) {
      classes.push("is-muted");
    }

    // Hide the OUTER .leaflet-marker-icon wrapper too. Inner display:none alone
    // leaves a transparent click/hover target at the marker's iconSize, which
    // can fire tooltips for buildings the user just filtered out.
    return leaflet.divIcon({
      className: "project-marker-icon" + (filteredOut ? " is-mk-hidden-outer" : ""),
      html: [
        '<div class="', classes.join(" "), '" style="',
        "--marker-width:", String(width), "px;",
        "--marker-height:", String(height), "px;",
        "--marker-depth:", String(depth), "px;",
        '">',
        '<span class="project-marker__shadow"></span>',
        '<span class="project-marker__east"></span>',
        '<span class="project-marker__top"></span>',
        '<span class="project-marker__front"></span>',
        "</div>"
      ].join(""),
      iconSize: [iconWidth, iconHeight],
      iconAnchor: [Math.round(iconWidth / 2), iconHeight - 8],
      tooltipAnchor: [Math.round(iconWidth / 2) + 10, -Math.round(height * 0.7)]
    });
  }

  function buildTooltipContent(project, isSelected) {
    const meta = [
      text(project.list.canonical_status),
      String(project.stories) + " ST",
      project.workflow.priority_score ? "P" + project.workflow.priority_score : "P—"
    ].join(" · ").toUpperCase();
    const lines = [
      '<div class="project-tooltip',
      isSelected ? " is-selected" : "",
      '">',
      '<div class="project-tooltip__name">',
      escapeHtml(text(project.map.project_name || project.list.project_name)),
      "</div>",
      '<div class="project-tooltip__meta">',
      escapeHtml(meta),
      "</div>"
    ];

    if (isSelected) {
      lines.push(
        '<div class="project-tooltip__sub">',
        escapeHtml(text(project.site.canonical_address)),
        "</div>"
      );
    }

    lines.push("</div>");
    return lines.join("");
  }

  function renderAll() {
    renderWorldHeader();
    renderList();
    renderDossier();
    updateMapState();
  }

  function renderWorldHeader() {
    // Masthead — In Lens counters + state chip strip.
    // spec-023i: counts must respect the active filter pills.
    // spec-023n: also respect the targets-overlay state — when overlay is
    // on, the "in lens" pool is just the highlighted-yellow set, not the
    // full filter pool.
    let scope = projects.filter(projectIsInLens);
    if (map && mappableProjects && mappableProjects.length) {
      try {
        const bounds = map.getBounds();
        const inView = scope.filter(function (p) {
          return bounds.contains([p.latitude, p.longitude]);
        });
        if (inView.length) scope = inView;
      } catch (e) { /* map not ready yet */ }
    }
    const total = scope.length;
    if (nodes.pulseTotal) nodes.pulseTotal.textContent = String(total);

    const tierA = scope.filter(function (p) { return String(p.list.target_tier || "").toUpperCase() === "A"; }).length;
    const dmKnown = scope.filter(function (p) {
      const s = String(p.workflow.decision_maker_status || "").toLowerCase();
      return s && s !== "unknown";
    }).length;
    const fubLinked = scope.filter(function (p) { return Array.isArray(p.contacts) && p.contacts.length > 0; }).length;
    const overdue = scope.filter(function (p) {
      const delta = daysFromGenerated(p.workflow.next_action_due_at);
      return delta !== null && delta <= 0;
    }).length;

    if (nodes.kpiPrio) nodes.kpiPrio._valueNode.textContent = String(tierA);
    if (nodes.kpiDm) nodes.kpiDm._valueNode.textContent = dmKnown + "/" + total;
    if (nodes.kpiFub) nodes.kpiFub._valueNode.textContent = fubLinked + "/" + total;
    if (nodes.kpiDue) nodes.kpiDue._valueNode.textContent = String(overdue);

    // State chip strip — group by workflow.state, honest counts
    if (nodes.stateChipStrip) {
      nodes.stateChipStrip.innerHTML = "";
      const byState = {};
      scope.forEach(function (p) {
        const s = String(p.workflow.state || "watch").toLowerCase();
        byState[s] = (byState[s] || 0) + 1;
      });
      const toneMap = {
        "pitched": "#3d5c48", "won": "#3d5c48",
        "in-discussion": "#6f8096",
        "follow-up-due": "#7b4a38", "stale": "#7b4a38", "lost": "#7b4a38",
        "needs-pitch": "#b77e5e"
      };
      Object.keys(byState).forEach(function (s) {
        const chip = createEl("span", "v62-statechip");
        chip.title = titleCaseToken(s) + " — " + String(byState[s]) + " " + (byState[s] === 1 ? "project" : "projects");
        const sw = createEl("span", "sw");
        sw.style.background = toneMap[s] || "#c8c3bb";
        chip.appendChild(sw);
        chip.appendChild(createEl("span", "n", String(byState[s])));
        nodes.stateChipStrip.appendChild(chip);
      });
    }
  }

  function renderList() {
    // List rail replaced by Lens filter panel; list is no-op in v62 shell.
  }

  // spec-023c: dev-pipeline detection + dossier renderer.
  function isDevProject(project) {
    if (!project) return false;
    const pid = String(project.project_id || "");
    return pid.indexOf("wm_proj_future_dev_") === 0;
  }

  function devOrDash(value) {
    if (value === null || value === undefined) return "—";
    const s = String(value).trim();
    return s.length ? s : "—";
  }

  function devNumberOrDash(value, suffix) {
    if (value === null || value === undefined || value === "") return "—";
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    const formatted = n >= 1000 ? n.toLocaleString("en-US") : String(n);
    return suffix ? formatted + " " + suffix : formatted;
  }

  function devDateOrDash(value) {
    if (!value) return "—";
    const s = String(value);
    // hermes returns ISO YYYY-MM-DD; render in long form for human read
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return s;
    const y = m[1], mo = m[2], d = m[3];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return months[parseInt(mo, 10) - 1] + " " + parseInt(d, 10) + ", " + y;
  }

  // spec-024: Supply pressure section. Renders the headline counts at
  // all three radii, the Haiku-narrated pitch verdict (when present),
  // and a competitor table that filters by tier. Same renderer is used
  // by both the pipeline dossier and the rentals dossier — the helper
  // figures out the right framing from `supply_pressure.anchor_mode`.
  function renderSupplyPressureSection(sp) {
    if (!sp || typeof sp !== "object") return null;
    const counts = sp.counts || {};
    const competitors = Array.isArray(sp.competitors) ? sp.competitors : [];
    const submarketCount = counts.submarket || 0;
    const totalUnits = counts.total_units_submarket || 0;

    const wrap = createEl("div", "dossier-section");
    wrap.appendChild(createEl("div", "dossier-section-title", "Supply pressure"));

    // Empty state — no competitors at any radius.
    if (submarketCount === 0) {
      const empty = createEl("div", "v62-pressure-empty",
        "Scarce supply — no comparable " + (sp.anchor_type || "buildings")
        + "s within 20 blocks of your delivery window.");
      wrap.appendChild(empty);
      return wrap;
    }

    // Headline: all three counts inline so the scarcity story is instant.
    const head = createEl("div", "v62-pressure-headline");
    const tightN = counts.tight || 0;
    const neighN = counts.neighborhood || 0;
    head.appendChild(createEl("span", "v62-pressure-blocks",
      tightN + " within 5 blocks · "));
    head.appendChild(createEl("span", "v62-pressure-blocks",
      neighN + " within 10 · "));
    head.appendChild(createEl("span", "v62-pressure-blocks",
      submarketCount + " within 20"));
    head.appendChild(createEl("span", "v62-pressure-units",
      " · " + totalUnits + " total units"));
    wrap.appendChild(head);

    // Window line — explicit so the broker knows what's being compared.
    if (sp.window_label) {
      wrap.appendChild(createEl("div", "v62-pressure-window",
        sp.window_label));
    }

    // Haiku pitch verdict (when present and non-null).
    if (sp.pressure_pitch && typeof sp.pressure_pitch === "string") {
      const pitch = createEl("div", "v62-pressure-pitch");
      pitch.appendChild(document.createTextNode(sp.pressure_pitch));
      wrap.appendChild(pitch);
    }

    // Tier toggle: defaults to neighborhood (10 blocks). User clicks pill
    // to widen the visible table; counts in headline never change.
    let activeTier = "neighborhood";
    const TIER_RANK = { tight: 0, neighborhood: 1, submarket: 2 };
    const TIER_LABELS = { tight: "5 blocks", neighborhood: "10 blocks", submarket: "20 blocks" };

    const toggle = createEl("div", "v62-pressure-toggle");
    ["tight", "neighborhood", "submarket"].forEach(function (tier) {
      const btn = createEl("button",
        "v62-pressure-toggle-btn" + (activeTier === tier ? " is-active" : ""),
        TIER_LABELS[tier]);
      btn.type = "button";
      btn.addEventListener("click", function () {
        if (activeTier === tier) return;
        activeTier = tier;
        renderTable();
        Array.prototype.forEach.call(toggle.children, function (child) {
          child.classList.toggle("is-active",
            child.textContent === TIER_LABELS[tier]);
        });
      });
      toggle.appendChild(btn);
    });
    wrap.appendChild(toggle);

    const tableWrap = createEl("div", "v62-pressure-table");
    wrap.appendChild(tableWrap);

    function renderTable() {
      tableWrap.innerHTML = "";
      const visible = competitors.filter(function (c) {
        return TIER_RANK[c.tier] <= TIER_RANK[activeTier];
      });
      if (!visible.length) {
        tableWrap.appendChild(createEl("div", "v62-pressure-empty",
          "No competitors within " + TIER_LABELS[activeTier] + "."));
        return;
      }
      visible.forEach(function (c) {
        const row = createEl("button", "v62-pressure-row");
        row.type = "button";
        row.appendChild(createEl("div", "v62-pressure-row-name",
          c.name || "(unnamed)"));
        const meta = createEl("div", "v62-pressure-row-meta");
        const unitsTxt = (c.units || "?") + " units";
        const devTxt = c.developer ? " · " + c.developer : "";
        meta.appendChild(createEl("span", "", unitsTxt + devTxt));
        row.appendChild(meta);
        const tail = createEl("div", "v62-pressure-row-tail");
        const dateBadges = [];
        if (c.completion_or_built) {
          dateBadges.push(c.completion_or_built);
        }
        if (c.is_estimated_date) dateBadges.push('<span class="v62-pressure-est">(est.)</span>');
        if (c.is_already_delivered) dateBadges.push('<span class="v62-pressure-delivered">(delivered)</span>');
        const ds = createEl("span", "v62-pressure-date");
        ds.innerHTML = dateBadges.join(" ");
        tail.appendChild(ds);
        tail.appendChild(createEl("span", "v62-pressure-dist",
          (c.distance_mi != null ? c.distance_mi.toFixed(2) + " mi" : "")));
        row.appendChild(tail);
        // Click → cross-link to that competitor's dossier.
        row.addEventListener("click", function () {
          if (c.project_id && typeof selectProjectByProjectId === "function") {
            selectProjectByProjectId(c.project_id);
          }
        });
        tableWrap.appendChild(row);
      });
    }
    renderTable();
    return wrap;
  }

  function devSection(title, rows) {
    const wrap = createEl("div", "dossier-section");
    wrap.appendChild(createEl("div", "dossier-section-title", title));
    const grid = createEl("div", "dev-grid");
    rows.forEach(function (row) {
      if (!row) return;
      const r = createEl("div", "dev-row");
      r.appendChild(createEl("div", "dev-row-label", row.label));
      const val = createEl("div", "dev-row-value");
      if (row.html) {
        val.innerHTML = row.html;
      } else {
        val.appendChild(document.createTextNode(row.value));
      }
      r.appendChild(val);
      grid.appendChild(r);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  function devLink(label, url) {
    if (!url) return null;
    return {
      label: label,
      html: '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="dev-link">' + escapeHtml(url) + '</a>',
    };
  }

  function renderDevDossier(dossier, selected) {
    const facts = selected.facts || {};
    const dev = facts.dev_facts || {};
    const team = dev.team || {};
    const construction = dev.construction || {};
    const sources = dev.sources || {};
    const site = selected.site || {};
    const map = selected.map || {};

    const rail = createEl("div", "dossier-rail");

    // Header
    const head = createEl("div", "dossier-head");
    const kicker = createEl("div", "dossier-kicker");
    const eyebrow = createEl("div", "dossier-eyebrow");
    eyebrow.appendChild(document.createTextNode("Development Brief"));
    eyebrow.appendChild(createEl("span", "dossier-eyebrow-id", " · " + String(selected.project_id || "").toUpperCase()));
    kicker.appendChild(eyebrow);
    const closeBtn = createEl("button", "dossier-close", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close dossier");
    closeBtn.addEventListener("click", clearSelection);
    kicker.appendChild(closeBtn);
    head.appendChild(kicker);

    head.appendChild(createEl("h2", "dossier-title", text(facts.project_name || map.project_name)));
    head.appendChild(createEl("div", "dossier-address",
      [text(site.canonical_address), text(site.neighborhood)].filter(Boolean).join(" · ")
    ));

    // State row: stage chip + "Pipeline" tag + stories/units summary
    const stateRow = createEl("div", "state-row");
    const stage = devOrDash(construction.stage || facts.target_notes);
    const stageChip = createEl("div", "brief-chip is-strong", stage);
    stageChip.title = "Stage — current development phase per hermes_newdev";
    stateRow.appendChild(stageChip);
    const pipelineChip = createEl("div", "brief-chip is-lease-not-marketed-yet", "Pipeline");
    pipelineChip.title = "Future development — not yet marketed";
    stateRow.appendChild(pipelineChip);
    const summary = (
      devNumberOrDash(construction.stories) + " ST · ~" +
      devNumberOrDash(construction.unit_count) + " units"
    );
    const summaryMeta = createEl("div", "state-meta", summary);
    stateRow.appendChild(summaryMeta);
    head.appendChild(stateRow);
    rail.appendChild(head);

    // Body sections
    const body = createEl("div", "dossier-body");

    // Decision makers / contact route — broker-action surface goes FIRST.
    // Structured DMs are sparse (only ~33 rows have real titled DMs after
    // the spec-023u rollback); the section gracefully degrades to
    // prose-only or empty when DMs aren't populated.
    const contacts = dev.contacts || {};
    const dms = Array.isArray(contacts.decision_makers) ? contacts.decision_makers : [];
    const dmSection = createEl("div", "dossier-section");
    dmSection.appendChild(createEl("div", "dossier-section-title", "Decision makers"));
    if (dms.length) {
      const grid = createEl("div", "dev-grid");
      dms.forEach(function (dm) {
        const r = createEl("div", "dev-row");
        const labelText = dm.rank === 1 ? "Primary" : "Secondary";
        r.appendChild(createEl("div", "dev-row-label", labelText));
        const val = createEl("div", "dev-row-value");
        val.appendChild(createEl("span", "dev-dm-name", dm.name || "—"));
        if (dm.title) {
          val.appendChild(createEl("span", "dev-dm-title", " · " + dm.title));
        }
        r.appendChild(val);
        grid.appendChild(r);
      });
      dmSection.appendChild(grid);
    }
    if (contacts.developer_general_contact) {
      const block = createEl("div", "dev-prose-block");
      block.appendChild(createEl("div", "dev-prose-label", "How to reach"));
      block.appendChild(createEl("div", "dev-prose", String(contacts.developer_general_contact)));
      dmSection.appendChild(block);
    }
    if (contacts.decision_maker_notes) {
      const block = createEl("div", "dev-prose-block");
      block.appendChild(createEl("div", "dev-prose-label", "Notes"));
      block.appendChild(createEl("div", "dev-prose", String(contacts.decision_maker_notes)));
      dmSection.appendChild(block);
    }
    if (!dms.length && !contacts.developer_general_contact && !contacts.decision_maker_notes) {
      const empty = createEl("div", "dev-empty");
      empty.appendChild(document.createTextNode(
        "No decision-maker info from hermes for this row."
      ));
      dmSection.appendChild(empty);
    }
    body.appendChild(dmSection);

    // Broker read — Haiku-generated pitch one-liner about filing cadence +
    // latest action + plausible TCO timing. Surfaces here (right under
    // decision makers) when present so the broker has the WHY-pitch cue
    // immediately after seeing WHO to call. Falls through to nothing when
    // the row has no DOB filings to narrate.
    const permitsForNarrative = dev.permits || {};
    if (permitsForNarrative.broker_narrative) {
      const brokerSection = createEl("div", "dossier-section");
      brokerSection.appendChild(createEl("div", "dossier-section-title", "Broker read"));
      const narrBlock = createEl("div", "dev-narrative");
      narrBlock.appendChild(createEl("div", "dev-narrative-text",
        String(permitsForNarrative.broker_narrative)));
      brokerSection.appendChild(narrBlock);
      body.appendChild(brokerSection);
    }

    // spec-024: Supply pressure — competing same-type buildings landing
    // in the anchor's lease-up window. Sits between Broker read and Team
    // because pressure is broker-pitch context, just like the Haiku
    // narrative above. Renders nothing when supply_pressure is missing.
    const sp = dev.supply_pressure;
    if (sp) {
      const sec = renderSupplyPressureSection(sp);
      if (sec) body.appendChild(sec);
    }

    body.appendChild(devSection("Team", [
      { label: "Developer", value: devOrDash(team.developer_org) },
      { label: "Architect", value: devOrDash(team.architect_org) },
      { label: "Owner", value: devOrDash(team.owner_org) },
    ]));

    // spec-025: every pre-construction completion date is an estimate by
    // nature — even the developer doesn't know the real TCO date. Render
    // the `(est.)` badge uniformly whenever the field is populated, so
    // we don't imply false precision on hermes-native dates over the
    // 39 stage-heuristic ones. (The _source / _confidence keys still
    // live in the payload for audit; we just stop exposing the split.)
    const ecdRaw = construction.estimated_completion_date;
    const ecdRow = ecdRaw
      ? { label: "Estimated completion",
          html: escapeHtml(devDateOrDash(ecdRaw)) +
                '<span class="dev-est-badge">(est.)</span>' }
      : { label: "Estimated completion", value: devDateOrDash(ecdRaw) };

    body.appendChild(devSection("Construction", [
      ecdRow,
      { label: "Stories", value: devNumberOrDash(construction.stories) },
      { label: "Units (planned)", value: devNumberOrDash(construction.unit_count) },
      { label: "Height", value: devNumberOrDash(construction.height_feet, "ft") },
      { label: "Square feet", value: devNumberOrDash(construction.square_feet) },
      { label: "Stage", value: devOrDash(construction.stage) },
      construction.tenure_type ? { label: "Tenure", value: devOrDash(construction.tenure_type) } : null,
    ]));

    // Sources — YIMBY (when present), then primary source URL, then excerpt
    const sourceRows = [];
    if (sources.yimby_url) sourceRows.push(devLink("YIMBY", sources.yimby_url));
    if (sources.source_url) {
      const label = sources.source_site ? sources.source_site : "Primary";
      sourceRows.push(devLink(label, sources.source_url));
    }
    if (sources.source_excerpt) {
      sourceRows.push({ label: "Excerpt", value: String(sources.source_excerpt) });
    }
    if (sourceRows.length) {
      body.appendChild(devSection("Sources", sourceRows));
    }

    // Permit updates — DOB filing data + progress prose + per-filing list.
    // Structured permit fields cover ~27/132 rows; progress_status prose
    // covers all 132 so the section always has something useful to say.
    // The broker_narrative Haiku line was hoisted out of this section into
    // its own "Broker read" block under Decision makers; we no longer let
    // it justify rendering this Permit updates section by itself.
    const permits = dev.permits || {};
    const filings = Array.isArray(permits.filings) ? permits.filings : [];
    const hasStructuredPermit = !!(
      permits.dob_primary_job_number || permits.dob_job_status ||
      permits.dob_latest_action || permits.dob_latest_action_date ||
      permits.dob_job_type
    );
    const hasProgress = !!permits.progress_status;
    const hasFilings = filings.length > 0;
    if (hasStructuredPermit || hasProgress || hasFilings) {
      const permitSection = createEl("div", "dossier-section");
      permitSection.appendChild(createEl("div", "dossier-section-title", "Permit updates"));

      if (hasStructuredPermit) {
        const grid = createEl("div", "dev-grid");
        const rows = [
          { label: "Primary job #", value: devOrDash(permits.dob_primary_job_number) },
          { label: "Job type", value: devOrDash(permits.dob_job_type) },
          { label: "Permit status", value: devOrDash(permits.dob_permit_status) },
          { label: "Latest action", value: devOrDash(permits.dob_latest_action) },
          { label: "Latest action date", value: devDateOrDash(permits.dob_latest_action_date) },
          { label: "Latest filing date", value: devDateOrDash(permits.dob_latest_filing_date) },
        ];
        rows.forEach(function (row) {
          const r = createEl("div", "dev-row");
          r.appendChild(createEl("div", "dev-row-label", row.label));
          r.appendChild(createEl("div", "dev-row-value", row.value));
          grid.appendChild(r);
        });
        permitSection.appendChild(grid);
      }

      // Note: spec-023g's "Broker read" Haiku narrative now lives in its
      // own dedicated section directly under Decision makers (above Team)
      // so the WHY-pitch cue is co-located with the WHO-to-call surface.
      // Remove from the permits grid here to avoid duplication.

      if (hasStructuredPermit && permits.dob_job_status) {
        const block = createEl("div", "dev-prose-block");
        block.appendChild(createEl("div", "dev-prose-label", "Filing history"));
        block.appendChild(createEl("div", "dev-prose", String(permits.dob_job_status)));
        permitSection.appendChild(block);
      }

      if (hasStructuredPermit && permits.dob_source_url) {
        const linkBlock = createEl("div", "dev-prose-block");
        linkBlock.innerHTML = '<a href="' + escapeHtml(permits.dob_source_url) +
          '" target="_blank" rel="noopener" class="dev-link">View DOB filings on NYC Open Data →</a>';
        permitSection.appendChild(linkBlock);
      }

      if (hasProgress) {
        const block = createEl("div", "dev-prose-block");
        block.appendChild(createEl("div", "dev-prose-label", "Latest status"));
        block.appendChild(createEl("div", "dev-prose", String(permits.progress_status)));
        permitSection.appendChild(block);
      }

      // spec-023g: per-filing list at the bottom — past-6-months + primary
      // anchor only. Each row clickable to NYC Open Data. Recent rows bolded.
      if (hasFilings) {
        const filingsBlock = createEl("div", "dev-prose-block");
        filingsBlock.appendChild(createEl("div", "dev-prose-label",
          "Filings (past 6 months + primary, " + filings.length + ")"));
        const list = createEl("ul", "dev-filings-list");
        filings.forEach(function (f) {
          const li = createEl("li", "dev-filing" + (f.is_recent ? " is-recent" : ""));
          const meta = [
            f.current_status_date || f.filing_date || "",
            f.job_type || "",
            f.work_types && f.work_types.length ? f.work_types.join(", ") : "",
            f.filing_status || "",
          ].filter(Boolean).join(" · ");
          const href = f.link || "";
          const flag = f.is_primary ? '<span class="dev-filing-flag">PRIMARY</span> ' : "";
          li.innerHTML = flag +
            (href
              ? '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener" class="dev-filing-link">' +
                escapeHtml(f.job_number || "") + '</a>'
              : '<span class="dev-filing-link">' + escapeHtml(f.job_number || "") + '</span>') +
            ' <span class="dev-filing-meta">' + escapeHtml(meta) + '</span>';
          list.appendChild(li);
        });
        filingsBlock.appendChild(list);
        permitSection.appendChild(filingsBlock);
      }

      body.appendChild(permitSection);
    }

    rail.appendChild(body);
    dossier.appendChild(rail);
  }

  function renderDossier() {
    const dossier = nodes.dossier;

    // spec-021: when the discovery input has fired a query, the right rail
    // shows the Targets list instead of the building dossier. Click a row
    // → discoveryActive flips off + dossier reverts to the standard view.
    if (discoveryActive) {
      renderTargetsList(dossier);
      return;
    }

    const selected = getSelectedProject();

    dossier.innerHTML = "";

    // spec-023c: dev-pipeline buildings (project_id starts wm_proj_future_dev_)
    // get their own dossier shape — rentals-specific sections (Active rentals,
    // Performance vs Peers, marketing-mode chip, etc.) don't apply to
    // pre-construction. The rental code path below stays unchanged.
    if (selected && isDevProject(selected)) {
      renderDevDossier(dossier, selected);
      return;
    }

    const rail = createEl("div", "dossier-rail");
    const head = createEl("div", "dossier-head");
    const kicker = createEl("div", "dossier-kicker");
    const eyebrow = createEl("div", "dossier-eyebrow");
    eyebrow.appendChild(document.createTextNode("Operating Brief"));
    if (selected) {
      const idSpan = createEl("span", "dossier-eyebrow-id", " · " + String(selected.project_id || "").toUpperCase());
      eyebrow.appendChild(idSpan);
    }
    kicker.appendChild(eyebrow);
    const closeButton = createEl("button", "dossier-close", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "Close dossier");
    closeButton.addEventListener("click", clearSelection);
    kicker.appendChild(closeButton);
    head.appendChild(kicker);

    if (!selected) {
      head.appendChild(createEl("h2", "dossier-title", "Today"));
      const today = new Date();
      const dateStr = today.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
      head.appendChild(createEl("div", "dossier-address", dateStr + " · No building selected"));
      rail.appendChild(head);

      const emptyBody = createEl("div", "dossier-body");

      // Last 30 days stats strip
      const statsStrip = createEl("div", "empty-stats");
      statsStrip.appendChild(createEl("div", "empty-stats-kicker", "Last 30 days"));
      const statsRow = createEl("div", "empty-stats-row");
      const pitched30 = projects.filter(function (p) {
        const s = String(p.workflow.state || "").toLowerCase();
        return s === "pitched" || s === "won";
      }).length;
      const inDisc = projects.filter(function (p) {
        return String(p.workflow.state || "").toLowerCase() === "in-discussion";
      }).length;
      const wonCount = projects.filter(function (p) {
        return String(p.workflow.state || "").toLowerCase() === "won";
      }).length;
      [
        { n: pitched30, label: "Pitched" },
        { n: inDisc, label: "In discussion" },
        { n: wonCount, label: "LOI / Won" }
      ].forEach(function (stat) {
        const cell = createEl("div", "empty-stat");
        cell.appendChild(createEl("div", "empty-stat-n", String(stat.n)));
        cell.appendChild(createEl("div", "empty-stat-label", stat.label));
        statsRow.appendChild(cell);
      });
      statsStrip.appendChild(statsRow);
      emptyBody.appendChild(statsStrip);

      // Today's queue — overdue + tier-A unknown DM
      const queueHead = createEl("div", "empty-section-head");
      queueHead.appendChild(createEl("div", "section-title", "Today's queue"));
      const queueItems = buildTodayQueue(projects, 4);
      queueHead.appendChild(createEl("span", "section-suffix", String(queueItems.length) + " to review"));
      emptyBody.appendChild(queueHead);

      if (queueItems.length === 0) {
        const emptyQ = createEl("div", "empty-soft", "Inbox zero — nothing overdue and every A-tier has a DM.");
        emptyBody.appendChild(emptyQ);
      } else {
        queueItems.forEach(function (q) {
          const card = createEl("button", "queue-card");
          card.type = "button";
          card.addEventListener("click", function () { setSelected(q.project.project_id); });
          const left = createEl("div", "queue-card-left");
          left.appendChild(createEl("div", "queue-card-title", text(q.project.facts.project_name || q.project.map.project_name)));
          left.appendChild(createEl("div", "queue-card-addr", text(q.project.site.canonical_address)));
          const reasons = createEl("div", "queue-card-reasons");
          q.reasons.forEach(function (r) {
            reasons.appendChild(createEl("span", "queue-reason" + (r.tone ? " is-" + r.tone : ""), r.label));
          });
          left.appendChild(reasons);
          card.appendChild(left);
          card.appendChild(createEl("span", "queue-card-arrow", "›"));
          emptyBody.appendChild(card);
        });
      }

      // Agent suggestions
      const aiHead = createEl("div", "empty-section-head");
      aiHead.appendChild(createEl("div", "section-title", "Agent suggestions"));
      aiHead.appendChild(createEl("span", "ai-glyph", "✦"));
      emptyBody.appendChild(aiHead);

      const suggestions = buildAgentSuggestions(projects);
      suggestions.forEach(function (s) {
        const card = createEl("div", "agent-card");
        const badge = createEl("span", "agent-badge", "✦");
        card.appendChild(badge);
        const body = createEl("div", "agent-body");
        body.appendChild(createEl("div", "agent-text", s.text));
        if (s.meta) body.appendChild(createEl("div", "agent-meta", s.meta));
        card.appendChild(body);
        emptyBody.appendChild(card);
      });

      rail.appendChild(emptyBody);
      dossier.appendChild(rail);
      return;
    }

    const workflow = selected.workflow || {};
    const crmRecordIds = parseRecordIds(workflow.crm_record_ids);
    const contacts = Array.isArray(selected.contacts) ? selected.contacts : [];
    const signals = Array.isArray(selected.dossier.signals) ? selected.dossier.signals : [];
    const dmStatus = String(workflow.decision_maker_status || "").toLowerCase();
    const stateId = String(workflow.state || "").toLowerCase();
    const isPitched = stateId === "pitched" || stateId === "won";

    const hasStreetEasy = !!(selected.facts && selected.facts.street_easy_url) || !!(selected.dossier && selected.dossier.street_easy_url);
    const actionItems = [
      { label: isPitched ? "Mark won" : "Mark pitched", icon: iconCheck(), primary: true },
      hasStreetEasy ? null : { label: "Add StreetEasy", icon: iconLink() },
      { label: "Schedule follow-up", icon: iconClock() },
      { label: "View pressure", icon: iconRings() }
    ].filter(Boolean);
    const addressLine = [
      text(selected.site.canonical_address),
      neutralText(selected.site.neighborhood, "Neighborhood —")
    ].join(" · ");

    head.appendChild(createEl("h2", "dossier-title", text(selected.facts.project_name || selected.map.project_name)));
    head.appendChild(createEl("div", "dossier-address", addressLine));

    const stateRow = createEl("div", "state-row");
    const mStatus = marketingStatus(selected);
    // phase-2b: marketing-mode chip is now a clickable cycle button. Click
    // advances in_house → outside_agent → unknown → in_house. The PATCH
    // /api/projects/{id} endpoint persists the change to wm_project
    // (Supabase) and stamps source='manual-edit' so future ETL re-runs
    // don't overwrite the user's edit. Optimistic UI: chip updates
    // immediately; revert on PATCH failure with a brief error indicator.
    const mChip = createEl("button", "brief-chip is-editable " + mStatus.tone, mStatus.label);
    mChip.type = "button";
    mChip.title = "Leasing mode — click to cycle in-house / outside agent / unknown";
    mChip.style.cursor = "pointer";
    mChip.addEventListener("click", function (evt) {
      evt.stopPropagation();
      // Cycle order: in_house → outside_agent → unknown → in_house.
      const current = String(
        (selected.facts && selected.facts.marketing_mode) || "unknown"
      ).toLowerCase();
      const cycle = ["in_house", "outside_agent", "unknown"];
      const idx = cycle.indexOf(current);
      const next = cycle[(idx + 1) % cycle.length];
      // Optimistic: update in-memory + visual chip immediately.
      const prev = selected.facts.marketing_mode;
      selected.facts.marketing_mode = next;
      const nextStatus = marketingStatus(selected);
      mChip.className = "brief-chip is-editable " + nextStatus.tone;
      mChip.textContent = nextStatus.label;
      // Persist to Supabase via the dev-server PATCH endpoint.
      wmFetchDevApi("/api/projects/" + encodeURIComponent(selected.project_id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ marketing_mode: next }),
      })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error("PATCH " + r.status + ": " + t.slice(0, 200)); });
          return r.json();
        })
        .then(function () {
          // On success: re-bake markers so the in-house/outside color
          // updates everywhere on the map, not just the chip.
          if (typeof applyAllFilters === "function") applyAllFilters();
        })
        .catch(function (err) {
          // Revert.
          console.warn("[wm] marketing_mode PATCH failed; reverting", err);
          selected.facts.marketing_mode = prev;
          const revertStatus = marketingStatus(selected);
          mChip.className = "brief-chip is-editable " + revertStatus.tone;
          mChip.textContent = revertStatus.label;
          // Tiny inline error indicator that auto-clears.
          const errEl = createEl("span", "wm-edit-error", " · save failed");
          errEl.style.color = "#a85a4a";
          errEl.style.fontSize = "10px";
          errEl.style.marginLeft = "4px";
          mChip.parentElement && mChip.parentElement.appendChild(errEl);
          setTimeout(function () { errEl.remove(); }, 3000);
        });
    });
    stateRow.appendChild(mChip);
    const dmChipStatus = decisionMakerStatus(workflow);
    const dmChip = createEl("button", "brief-chip is-editable " + dmChipStatus.tone, dmChipStatus.label);
    dmChip.type = "button";
    dmChip.title = "Decision-maker status — click to toggle known / unknown";
    dmChip.style.cursor = "pointer";
    dmChip.addEventListener("click", function (evt) {
      evt.stopPropagation();
      const current = String(
        (selected.workflow && selected.workflow.decision_maker_status) || "unknown"
      ).toLowerCase();
      const next = current === "known" ? "unknown" : "known";
      const prev = selected.workflow.decision_maker_status;
      selected.workflow.decision_maker_status = next;
      const nextStatus = decisionMakerStatus(selected.workflow);
      dmChip.className = "brief-chip is-editable " + nextStatus.tone;
      dmChip.textContent = nextStatus.label;
      wmFetchDevApi("/api/projects/" + encodeURIComponent(selected.project_id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ decision_maker_status: next }),
      })
        .then(function (r) {
          if (!r.ok) return r.text().then(function (t) { throw new Error("PATCH " + r.status + ": " + t.slice(0, 200)); });
          return r.json();
        })
        .then(function () {
          if (typeof applyAllFilters === "function") applyAllFilters();
        })
        .catch(function (err) {
          console.warn("[wm] decision_maker_status PATCH failed; reverting", err);
          selected.workflow.decision_maker_status = prev;
          const revertStatus = decisionMakerStatus(selected.workflow);
          dmChip.className = "brief-chip is-editable " + revertStatus.tone;
          dmChip.textContent = revertStatus.label;
          const errEl = createEl("span", "wm-edit-error", " · save failed");
          errEl.style.color = "#a85a4a";
          errEl.style.fontSize = "10px";
          errEl.style.marginLeft = "4px";
          dmChip.parentElement && dmChip.parentElement.appendChild(errEl);
          setTimeout(function () { errEl.remove(); }, 3000);
        });
    });
    stateRow.appendChild(dmChip);
    const wfChip = createEl("div", "brief-chip " + workflowTone(workflow.state), workflowLabel(workflow.state));
    wfChip.title = "Workflow state — current position in your outreach pipeline";
    stateRow.appendChild(wfChip);
    const tChip = createEl("div", "brief-chip is-strong", tierLabel(selected.list.target_tier));
    tChip.title = "Target tier — A (priority), B (standard), C (backlog)";
    stateRow.appendChild(tChip);
    const tMeta = createEl("div", "state-meta", typeLabelWithCompletion(selected));
    tMeta.title = "Residential type · Standing vs Pipeline · Canonical status";
    stateRow.appendChild(tMeta);
    head.appendChild(stateRow);

    const actionCluster = createEl("div", "action-cluster");
    const actionRow = createEl("div", "action-row");
    actionItems.forEach(function (item) {
      const classes = ["action-chip", "is-disabled"];
      if (item.primary) classes.push("is-primary");
      const chip = createEl("button", classes.join(" "));
      chip.type = "button";
      chip.disabled = true;
      chip.setAttribute("aria-disabled", "true");
      chip.title = "Action not wired in this static pilot";
      if (item.icon) chip.appendChild(item.icon);
      chip.appendChild(document.createTextNode(item.label));
      actionRow.appendChild(chip);
    });
    actionCluster.appendChild(actionRow);
    head.appendChild(actionCluster);
    head.appendChild(createEl("div", "action-support", "014C action row transplanted visually. Actions are honestly disabled in this static pilot — no fake affordances."));
    rail.appendChild(head);

    const body = createEl("div", "dossier-body");

    // Decision maker — renders from canonical contacts[] (spec-012). The
    // legacy uiMock.decision_makers is honored only when contacts[] is empty
    // and a uiMock entry exists, so the prototype's hand-crafted demo project
    // still demonstrates the full state without polluting real data.
    body.appendChild(renderSection("Decision maker", null, function (node) {
      const real = Array.isArray(selected.contacts) ? selected.contacts : [];
      const fallback = Array.isArray(selected.uiMock.decision_makers) ? selected.uiMock.decision_makers : [];
      const dms = real.length
        ? real.map(function (c) {
            return {
              contact_id: c.contact_id || "",
              name: c.name || "—",
              role: c.role || (c.created_via === "dm-promotion" ? "Promoted DM" : null),
              org: c.org || "",
              status: c.status || "primary",
              email: c.email || "",
              phone: c.phone || "",
              fub_id: c.fub_id || "",
            };
          })
        : fallback;
      if (!dms.length) {
        const addRow = createEl("button", "editable-block is-dashed");
        addRow.type = "button";
        addRow.title = "Promote a decision maker — name + optional phone/email";
        const stack = createEl("div", "kv-stack");
        stack.appendChild(createEl("div", "kv-label", "Decision maker"));
        stack.appendChild(createEl("div", "kv-empty", "Add decision maker — creates a contact on this building"));
        addRow.appendChild(stack);
        addRow.appendChild(plusGlyph());
        addRow.addEventListener("click", function () {
          openDmPromotionForm(selected, null, addRow);
        });
        node.appendChild(addRow);
      } else {
        const list = createEl("div", "fub-list");
        dms.forEach(function (dm) {
          const row = createEl("div", "fub-row");
          row.appendChild(fubAvatar(dm.name));
          const bodyEl = createEl("div", "fub-body");
          const nameRow = createEl("div", "fub-name");
          nameRow.appendChild(document.createTextNode(dm.name));
          if ((dm.status || "primary") === "primary") {
            const chip = createEl("span", "brief-chip is-strong", "Primary");
            chip.style.marginLeft = "8px";
            chip.style.fontSize = "9px";
            chip.style.padding = "2px 6px";
            nameRow.appendChild(chip);
          } else {
            const chip = createEl("span", "brief-chip is-neutral", "Secondary");
            chip.style.marginLeft = "8px";
            chip.style.fontSize = "9px";
            chip.style.padding = "2px 6px";
            nameRow.appendChild(chip);
          }
          bodyEl.appendChild(nameRow);
          const meta = [dm.role, dm.org, dm.email, dm.phone].filter(Boolean).join(" · ");
          if (meta) bodyEl.appendChild(createEl("div", "fub-meta", meta));
          row.appendChild(bodyEl);
          if (dm.contact_id) {
            const editBtn = createEl("button", "fub-edit");
            editBtn.type = "button";
            editBtn.title = "Edit decision maker";
            editBtn.setAttribute("aria-label", "Edit decision maker");
            editBtn.appendChild(createEl("span", "editable-pencil", "✎"));
            editBtn.addEventListener("click", function () {
              openDmPromotionForm(selected, {
                editingContactId: dm.contact_id,
                name: dm.name,
                phone: dm.phone || "",
                email: dm.email || "",
                fub_id: dm.fub_id || "",
              }, row);
            });
            row.appendChild(editBtn);
          }
          if (dm.fub_id) {
            const link = createEl("a", "fub-chip is-linked");
            link.href = "https://app.followupboss.com/2/people/view/" + encodeURIComponent(dm.fub_id);
            link.target = "_blank";
            link.rel = "noopener";
            link.title = "Open in Follow Up Boss (id " + dm.fub_id + ")";
            link.appendChild(iconFub());
            link.appendChild(createEl("span", "fub-chip-label", "FUB"));
            row.appendChild(link);
          } else {
            const addFub = createEl("button", "fub-chip is-unlinked");
            addFub.type = "button";
            addFub.disabled = true;
            addFub.title = "Create in Follow Up Boss — wires in CODEX-SPEC-011";
            addFub.appendChild(plusGlyph());
            addFub.appendChild(createEl("span", "fub-chip-label", "FUB"));
            row.appendChild(addFub);
          }
          list.appendChild(row);
        });
        const addAnother = createEl("button", "editable-block is-dashed");
        addAnother.type = "button";
        addAnother.title = "Promote another decision maker on this building";
        const stack = createEl("div", "kv-stack");
        stack.appendChild(createEl("div", "kv-label", "Decision maker"));
        stack.appendChild(createEl("div", "kv-empty", "Add another"));
        addAnother.appendChild(stack);
        addAnother.appendChild(plusGlyph());
        addAnother.addEventListener("click", function () {
          openDmPromotionForm(selected, null, addAnother);
        });
        node.appendChild(list);
        node.appendChild(addAnother);
      }
    }));

    // Marketing & brokerage
    body.appendChild(renderSection("Marketing & brokerage", null, function (node) {
      const grid = createEl("div", "mini-grid");
      grid.appendChild(editableOrgRow(selected, "Owner", "owner", orgNames(selected.organizations.sponsors)));
      grid.appendChild(editableOrgRow(selected, "Manager", "manager", orgNames(selected.organizations.operators)));
      grid.appendChild(editableOrgRow(selected, "Broker", "broker", orgNames(selected.organizations.marketers)));
      grid.appendChild(listingAgentRow(selected));
      node.appendChild(grid);

      // StreetEasy row — live <a> when URL present, dashed disabled "Add" when empty.
      const seUrl = (selected.facts && selected.facts.street_easy_url) || selected.uiMock.street_easy_url || "";
      if (seUrl) {
        const seLink = createEl("a", "editable-block");
        seLink.href = seUrl;
        seLink.target = "_blank";
        seLink.rel = "noopener noreferrer";
        seLink.title = "Open StreetEasy listing in a new tab";
        seLink.style.marginTop = "12px";
        seLink.style.textDecoration = "none";
        seLink.style.color = "inherit";
        const seStack = createEl("div", "kv-stack");
        seStack.appendChild(createEl("div", "kv-label", "StreetEasy"));
        seStack.appendChild(createEl("div", "kv-value", seUrl.replace(/^https?:\/\//, "")));
        seLink.appendChild(seStack);
        seLink.appendChild(editGlyph());
        node.appendChild(seLink);
      } else {
        const seCard = createEl("button", "editable-block is-dashed");
        seCard.type = "button";
        seCard.disabled = true;
        seCard.title = "Not wired in this static pilot";
        seCard.style.marginTop = "12px";
        const seStack = createEl("div", "kv-stack");
        seStack.appendChild(createEl("div", "kv-label", "StreetEasy"));
        seStack.appendChild(createEl("div", "kv-empty", "Add StreetEasy — paste a listing or building URL"));
        seCard.appendChild(seStack);
        seCard.appendChild(plusGlyph());
        node.appendChild(seCard);
      }

      // Active rentals (CODEX-SPEC-017). Renders directly under the SE link
      // inside Marketing & brokerage. When the spec-017 overlay hasn't
      // injected dossier.summary / .listings / .listing_events_recent yet
      // (file missing during rollout, or building outside our coverage),
      // fall back to the "never observed" empty-state copy.
      renderActiveRentalsSection(node, selected);
    }));

    // spec-024: Supply pressure — pipeline + recently-delivered competing
    // rentals landing inside the next 12 mo. Sits ABOVE Performance vs
    // peers because pressure is forward-looking and complements the
    // historical lease-velocity metric below.
    const rentalSp = (selected.facts || {}).supply_pressure;
    if (rentalSp) {
      const sec = renderSupplyPressureSection(rentalSp);
      if (sec) body.appendChild(sec);
    }

    // Performance vs peers (CODEX-SPEC-018c). Async fetch against the
    // dev-server's /api/buildings/{id}/performance endpoint, which reads
    // building_performance_history (spec-018a) + weakness_one_liner
    // (spec-018b) from Supabase. Empty/calibration/peer-out states all
    // render gracefully in-place.
    body.appendChild(renderSection("Performance vs peers", null, function (node) {
      renderPerformanceVsPeersSection(node, selected);
    }));

    // Mystery shop
    body.appendChild(renderSection("Mystery shop", null, function (node) {
      node.appendChild(createEl("div", "empty-soft", "No mystery shop on file · request shop action not wired in this pilot."));
    }));

    // Permit & DOB activity
    body.appendChild(renderSection("Permit & DOB activity", null, function (node) {
      const grid = createEl("div", "mini-grid");
      grid.appendChild(miniRow("Activity", function (val) {
        val.appendChild(document.createTextNode("—"));
      }));
      grid.appendChild(miniRow("Stage", function (val) {
        val.appendChild(document.createTextNode(titleCaseToken(selected.facts.canonical_status || selected.list.canonical_status) || "—"));
      }));
      const marketMode = String(selected.facts.market_mode || selected.list.market_mode || "").toLowerCase();
      grid.appendChild(miniRow("Mode", function (val) {
        val.appendChild(document.createTextNode(marketMode ? titleCaseToken(marketMode) : "—"));
      }));
      grid.appendChild(miniRow("Units", function (val) {
        const units = selected.facts.unit_count || selected.list.unit_count;
        val.style.fontVariantNumeric = "tabular-nums";
        val.appendChild(document.createTextNode(units ? Number(units).toLocaleString() : "—"));
      }));
      node.appendChild(grid);
      node.appendChild(createEl("div", "callout", "Permit and DOB activity signals are not carried in the current rentals-first payload. This section stays mounted to preserve 014C structural parity."));
    }));

    // Why-now signals
    body.appendChild(renderSection("Why-now signals", null, function (node) {
      if (!signals.length) {
        node.appendChild(createEl("div", "empty-soft", "No signals recorded in payload."));
        return;
      }
      const list = createEl("div", "signal-list");
      signals.slice(0, 3).forEach(function (signal) {
        const el = createEl("div", "signal");
        el.appendChild(createEl("div", "signal-meta", [
          formatDate(signal.observed_at),
          text(signal.signal_source),
          titleCaseToken(signal.signal_type)
        ].join(" · ")));
        el.appendChild(createEl("div", "signal-head", text(signal.headline)));
        el.appendChild(createEl("div", "signal-body", text(signal.summary)));
        list.appendChild(el);
      });
      node.appendChild(list);
    }));

    // Notes & corrections
    body.appendChild(renderSection("Notes & corrections",
      workflow.notes ? "1" : "0",
      function (node) {
        const composer = createEl("div", "note-composer");
        const input = createEl("input");
        input.type = "text";
        input.placeholder = "Add correction or note…";
        input.disabled = true;
        input.title = "Note composer visible but not wired in static pilot";
        composer.appendChild(input);
        const logBtn = createEl("button", "", "Log");
        logBtn.type = "button";
        logBtn.disabled = true;
        logBtn.title = "Note persistence not wired in static pilot";
        composer.appendChild(logBtn);
        node.appendChild(composer);

        if (workflow.notes) {
          const log = createEl("div", "note-log");
          const entry = createEl("div", "note-entry");
          entry.appendChild(createEl("div", "note-entry-date", formatDate(workflow.last_touched_at)));
          entry.appendChild(document.createTextNode(text(workflow.notes)));
          log.appendChild(entry);
          node.appendChild(log);
        }
      }));

    rail.appendChild(body);
    dossier.appendChild(rail);
  }

  function renderSection(title, suffix, fill) {
    const section = createEl("section", "section");
    const headRow = createEl("div", "section-head");
    headRow.appendChild(createEl("div", "section-title", title));
    if (suffix) headRow.appendChild(createEl("div", "section-suffix", suffix));
    section.appendChild(headRow);
    const body = createEl("div");
    body.style.display = "flex";
    body.style.flexDirection = "column";
    body.style.gap = "8px";
    fill(body);
    section.appendChild(body);
    return section;
  }

  // ---- Active rentals (CODEX-SPEC-017) ------------------------------------
  // Renders inline under the StreetEasy link inside the Marketing & brokerage
  // section. Reads from spec-017 dossier overlay fields (`summary`,
  // `listings`, `listing_events_recent`). When the overlay isn't present
  // (file missing during rollout, or building outside our coverage), falls
  // back to the "never observed" empty state.

  function renderActiveRentalsSection(node, project) {
    const dossier = project.dossier || {};
    const summary = dossier.summary || null;
    const listings = Array.isArray(dossier.listings) ? dossier.listings : [];
    const events = Array.isArray(dossier.listing_events_recent) ? dossier.listing_events_recent : [];

    const wrap = createEl("div");
    wrap.style.marginTop = "16px";
    wrap.style.paddingTop = "12px";
    wrap.style.borderTop = "1px solid var(--line)";

    const header = createEl("div");
    header.style.fontSize = "11px";
    header.style.letterSpacing = "0.08em";
    header.style.textTransform = "uppercase";
    header.style.color = "var(--ink-soft)";
    header.style.marginBottom = "10px";
    header.appendChild(document.createTextNode("Active rentals"));
    wrap.appendChild(header);

    // Empty-state matrix per spec-017 §D.
    if (!summary) {
      wrap.appendChild(createEl("div", "empty-soft", "We haven't observed any listings at this building yet."));
      node.appendChild(wrap);
      return;
    }

    const lastSeenAt = summary.last_seen_at ? new Date(summary.last_seen_at) : null;
    const now = new Date();
    const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
    const isStale = lastSeenAt && (now - lastSeenAt) > FOURTEEN_DAYS_MS;
    const activeCount = summary.active_rentals || 0;
    const isRealSilence = lastSeenAt && !isStale && activeCount === 0;

    if (!lastSeenAt) {
      wrap.appendChild(createEl("div", "empty-soft", "We haven't observed any listings at this building yet."));
      node.appendChild(wrap);
      return;
    }
    if (isStale) {
      const stale = createEl("div", "empty-soft");
      stale.style.borderLeft = "3px solid #c8a960";
      stale.style.paddingLeft = "10px";
      stale.appendChild(document.createTextNode(
        "Listing data last refreshed " + lastSeenAt.toLocaleDateString() +
        " — current state may have moved."
      ));
      wrap.appendChild(stale);
      node.appendChild(wrap);
      return;
    }
    if (isRealSilence) {
      const days = Math.max(0, Math.round((now - lastSeenAt) / (24 * 60 * 60 * 1000)));
      const dayWord = days === 1 ? "day" : "days";
      wrap.appendChild(createEl("div", "empty-soft",
        "No active listings — last seen " + days + " " + dayWord + " ago."));
      node.appendChild(wrap);
      return;
    }

    // Populated state.
    wrap.appendChild(buildActiveRentalsMetricRow(summary));
    if (events.length) {
      wrap.appendChild(buildMostRecentCallout(events));
    }
    if (listings.length) {
      const cards = createEl("div");
      cards.style.display = "flex";
      cards.style.flexDirection = "column";
      cards.style.gap = "8px";
      cards.style.marginTop = "8px";
      listings.forEach(function (listing) {
        cards.appendChild(buildListingCard(listing));
      });
      wrap.appendChild(cards);
    }

    node.appendChild(wrap);
  }

  function buildActiveRentalsMetricRow(summary) {
    const row = createEl("div");
    row.style.display = "flex";
    row.style.gap = "16px";
    row.style.fontVariantNumeric = "tabular-nums";
    row.style.marginBottom = "4px";

    function cell(value, label) {
      const c = createEl("div");
      c.style.flex = "1";
      c.style.minWidth = "0";
      const num = createEl("div");
      num.style.fontSize = "20px";
      num.style.fontWeight = "600";
      num.style.color = "var(--ink)";
      num.appendChild(document.createTextNode(value == null ? "—" : String(value)));
      const lab = createEl("div");
      lab.style.fontSize = "11px";
      lab.style.letterSpacing = "0.06em";
      lab.style.color = "var(--ink-soft)";
      lab.style.marginTop = "2px";
      lab.appendChild(document.createTextNode(label));
      c.appendChild(num);
      c.appendChild(lab);
      return c;
    }

    row.appendChild(cell(summary.active_rentals || 0, "active"));
    row.appendChild(cell(summary.reductions_30d || 0, "reductions 30d"));
    row.appendChild(cell(summary.median_dom_active, "median DOM"));
    row.appendChild(cell(summary.departures_90d || 0, "departures 90d"));
    return row;
  }

  function buildMostRecentCallout(events) {
    const line = createEl("div");
    line.style.fontSize = "12px";
    line.style.color = "var(--ink-soft)";
    line.style.marginTop = "8px";
    const headlines = events.slice(0, 2)
      .map(function (e) { return e && (e.headline || e.event_type) ? (e.headline || e.event_type) : null; })
      .filter(Boolean)
      .join(" · ");
    line.appendChild(document.createTextNode("Most recent: " + (headlines || "—")));
    return line;
  }

  function buildListingCard(listing) {
    const card = createEl("div");
    card.style.padding = "10px 12px";
    card.style.background = "var(--panel)";
    card.style.border = "1px solid var(--line)";
    card.style.borderRadius = "8px";

    // Line 1: apt (link) · beds · ask · DOM
    const line1 = createEl("div");
    line1.style.fontSize = "13px";
    line1.style.fontWeight = "600";
    line1.style.color = "var(--ink)";
    line1.style.fontVariantNumeric = "tabular-nums";

    const aptText = listing.unit_label || "—";
    if (listing.listing_url) {
      const a = createEl("a");
      a.href = listing.listing_url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.style.color = "inherit";
      a.style.textDecoration = "underline";
      a.style.textDecorationColor = "var(--line-strong)";
      a.title = listingHoverPreview(listing);
      a.appendChild(document.createTextNode(aptText));
      line1.appendChild(a);
    } else {
      const span = createEl("span");
      span.title = listingHoverPreview(listing);
      span.appendChild(document.createTextNode(aptText));
      line1.appendChild(span);
    }

    const tailParts = [];
    if (listing.beds != null) tailParts.push(listing.beds + "BR");
    if (listing.list_price != null) tailParts.push("$" + Number(listing.list_price).toLocaleString());
    if (listing.se_days_on_market != null) tailParts.push(listing.se_days_on_market + " DOM");
    if (tailParts.length) {
      line1.appendChild(document.createTextNode(" · " + tailParts.join(" · ")));
    }
    card.appendChild(line1);

    // Line 2: net effective · status · concession
    const line2 = createEl("div");
    line2.style.fontSize = "12px";
    line2.style.color = "var(--ink-soft)";
    line2.style.marginTop = "2px";
    line2.style.fontVariantNumeric = "tabular-nums";
    const parts = [];
    if (listing.net_effective_monthly_rent != null) {
      let nem = "Net $" + Number(listing.net_effective_monthly_rent).toLocaleString();
      if (listing.net_effective_derived) nem += " (derived)";
      parts.push(nem);
    }
    if (listing.status) parts.push(titleCaseToken(listing.status) || listing.status);
    if (listing.concession_summary) parts.push(listing.concession_summary);
    line2.appendChild(document.createTextNode(parts.join(" · ") || "—"));
    card.appendChild(line2);

    return card;
  }

  function listingHoverPreview(listing) {
    const lines = [];
    if (listing.broker_name) {
      lines.push(listing.broker_name + (listing.brokerage_name ? " (" + listing.brokerage_name + ")" : ""));
    } else if (listing.brokerage_name) {
      lines.push(listing.brokerage_name);
    }
    if (listing.lease_months) {
      lines.push(listing.lease_months + "-month lease");
    }
    if (listing.concession_summary) {
      lines.push("Concession: " + listing.concession_summary);
    }
    if (listing.description_excerpt) {
      lines.push("");
      lines.push(listing.description_excerpt);
    }
    return lines.join("\n");
  }

  // ---- Performance vs peers (CODEX-SPEC-018c) -----------------------------
  // Async-fetches /api/buildings/{project_id}/performance and renders the
  // narrated headline, per-tier delta table, and (when there are at least 2
  // weekly measurements) a 1BR DOM trajectory chart with peer-median overlay.
  // The dev-server's _resolve_building_id() accepts the wm_... project_id
  // string so the frontend doesn't need to know the integer building.id.

  function renderPerformanceVsPeersSection(node, project) {
    const wrap = createEl("div");
    const loading = createEl("div", "empty-soft", "Loading performance comparison…");
    wrap.appendChild(loading);
    node.appendChild(wrap);

    const projectId = project && project.project_id;
    if (!projectId) {
      wrap.innerHTML = "";
      wrap.appendChild(buildPerfCalibrationEmpty());
      return;
    }

    const url = "/api/buildings/" + encodeURIComponent(projectId) + "/performance";
    // spec-027d: routed through wmFetchDevApi so the static demo falls
    // through to the deployed Fly backend when the local dev-server isn't up.
    wmFetchDevApi(url, {headers: {"Accept": "application/json"}})
      .then(function (resp) {
        return resp.json().then(function (data) {
          return {status: resp.status, ok: resp.ok, data: data};
        });
      })
      .then(function (r) {
        wrap.innerHTML = "";
        if (r.status === 404) {
          wrap.appendChild(buildPerfCalibrationEmpty());
          return;
        }
        if (!r.ok) {
          wrap.appendChild(createEl("div", "empty-soft",
            "Performance data temporarily unavailable."));
          return;
        }
        const data = r.data || {};
        const tiers = Array.isArray(data.tiers) ? data.tiers : [];

        // spec-018d: silent state — distinct from in-line-with-peers.
        if (data.activity_state === "no_data") {
          wrap.appendChild(buildPerfSilentEmpty());
          return;
        }

        if (!tiers.length) {
          wrap.appendChild(buildPerfCalibrationEmpty());
          return;
        }
        const overall = tiers.find(function (t) { return t.bedroom_tier === "overall"; }) || {};
        if (!overall || (overall.peer_set_size || 0) === 0) {
          wrap.appendChild(buildPerfCalibrationEmpty());
          return;
        }

        // Headline (narrated one-liner OR neutral fallback).
        wrap.appendChild(buildPerfHeadline(data.weakness_one_liner));

        // spec-018d: lease velocity sub-block (top — preferred metric).
        wrap.appendChild(buildLeaseVelocityTable(data, tiers, overall));

        // spec-018d: currently available sub-block (bottom — secondary signal).
        wrap.appendChild(buildCurrentlyAvailableTable(data, tiers, overall));

        // Trajectory: lazy-load. Show a placeholder until history arrives.
        const chartHost = createEl("div");
        chartHost.style.marginTop = "16px";
        chartHost.style.paddingTop = "12px";
        chartHost.style.borderTop = "1px solid var(--line)";
        wrap.appendChild(chartHost);
        const chartPlaceholder = createEl("div", "empty-soft",
          "Loading trajectory…");
        chartHost.appendChild(chartPlaceholder);

        const trajectoryTier = pickTrajectoryTier(tiers);
        const histUrl = "/api/buildings/" + encodeURIComponent(projectId)
          + "/performance/history?tier=" + encodeURIComponent(trajectoryTier);
        // spec-027d: routed through wmFetchDevApi (Fly fallback for static demo).
        wmFetchDevApi(histUrl, {headers: {"Accept": "application/json"}})
          .then(function (resp) { return resp.json(); })
          .then(function (h) {
            chartHost.innerHTML = "";
            chartHost.appendChild(buildPerfTrajectory(h, trajectoryTier));
          })
          .catch(function () {
            chartHost.innerHTML = "";
          });
      })
      .catch(function () {
        wrap.innerHTML = "";
        wrap.appendChild(createEl("div", "empty-soft",
          "Performance data temporarily unavailable."));
      });
  }

  function buildPerfCalibrationEmpty() {
    return createEl("div", "empty-soft",
      "Comparison in progress — competitors still being calibrated for this building.");
  }

  function buildPerfSilentEmpty() {
    // spec-018d: distinct from "in line with peers" — this is observability,
    // not performance. Visually marked with a left rule so users notice it
    // means something different.
    const wrap = createEl("div", "empty-soft");
    wrap.style.borderLeft = "3px solid var(--line-strong)";
    wrap.style.paddingLeft = "10px";
    wrap.style.fontStyle = "italic";
    wrap.appendChild(document.createTextNode(
      "No observed activity at this building in the last 90 days — no listings posted and no leases recorded. Comparison resumes when we observe new listings."
    ));
    return wrap;
  }

  function buildPerfHeadline(text) {
    const row = createEl("div");
    row.style.display = "flex";
    row.style.gap = "12px";
    row.style.alignItems = "flex-start";
    row.style.marginBottom = "14px";

    const headline = createEl("div");
    headline.style.fontSize = "15px";
    headline.style.lineHeight = "1.45";
    headline.style.fontWeight = "500";
    headline.style.color = "var(--ink)";
    headline.style.flex = "1 1 auto";

    if (!text) {
      headline.style.color = "var(--ink-soft)";
      headline.style.fontWeight = "400";
      headline.textContent = "Performing in line with neighborhood peers.";
      row.appendChild(headline);
      return row;
    }

    headline.textContent = text;
    row.appendChild(headline);

    if (navigator && navigator.clipboard) {
      const btn = createEl("button");
      btn.type = "button";
      btn.textContent = "Copy";
      btn.style.fontSize = "10px";
      btn.style.letterSpacing = "0.06em";
      btn.style.textTransform = "uppercase";
      btn.style.padding = "4px 10px";
      btn.style.border = "1px solid var(--line)";
      btn.style.background = "transparent";
      btn.style.color = "var(--ink-soft)";
      btn.style.cursor = "pointer";
      btn.style.borderRadius = "999px";
      btn.style.flex = "0 0 auto";
      btn.addEventListener("click", function () {
        navigator.clipboard.writeText(text).then(function () {
          btn.textContent = "Copied";
          setTimeout(function () { btn.textContent = "Copy"; }, 1500);
        }, function () {});
      });
      row.appendChild(btn);
    }
    return row;
  }

  function buildPerfSubBlockHeader(label, peerNote) {
    // spec-018d: small uppercase header used by the lease-velocity and
    // currently-available sub-blocks, optionally with a "vs cohort (n=X)"
    // subtitle on the same line.
    const wrap = createEl("div");
    wrap.style.display = "flex";
    wrap.style.alignItems = "baseline";
    wrap.style.justifyContent = "space-between";
    wrap.style.marginBottom = "6px";
    const left = createEl("div");
    left.style.fontSize = "10px";
    left.style.letterSpacing = "0.08em";
    left.style.textTransform = "uppercase";
    left.style.color = "var(--ink-soft)";
    left.textContent = label;
    wrap.appendChild(left);
    if (peerNote) {
      const right = createEl("div");
      right.style.fontSize = "10px";
      right.style.color = "var(--ink-faint)";
      right.textContent = peerNote;
      wrap.appendChild(right);
    }
    return wrap;
  }

  function buildPerfHeaderRow(grid, headers) {
    // spec-018d: shared helper to emit a header row across a CSS grid.
    headers.forEach(function (h, i) {
      const cell = createEl("div");
      cell.textContent = h;
      cell.style.fontSize = "10px";
      cell.style.letterSpacing = "0.05em";
      cell.style.textTransform = "uppercase";
      cell.style.color = "var(--ink-faint)";
      cell.style.paddingBottom = "6px";
      cell.style.paddingTop = "4px";
      cell.style.borderBottom = "1px solid var(--line)";
      cell.style.textAlign = i === 0 ? "left" : "right";
      grid.appendChild(cell);
    });
  }

  function buildLeaseVelocityTable(data, tiers, overall) {
    // spec-018d: top sub-block. Uses RENTED-event medians from the last 90d.
    // Suppressed rows where competitors has <3 leases (peer_median_days_to_rent
    // is NULL — see compute step's MIN_PEER_LEASES_FOR_VELOCITY).
    const wrap = createEl("div");
    wrap.style.fontVariantNumeric = "tabular-nums";

    const nb = (data.peer_set && data.peer_set.neighborhood) || "neighborhood";
    const peerN = (data.peer_set && data.peer_set.size) || 0;
    wrap.appendChild(buildPerfSubBlockHeader(
      "Lease velocity (last 90 days)",
      "vs " + nb + " competitors (n=" + peerN + ")"
    ));

    const grid = createEl("div");
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "auto 1fr 1fr 1fr 1fr 1fr";
    grid.style.columnGap = "10px";
    grid.style.rowGap = "0";
    grid.style.fontSize = "12px";
    buildPerfHeaderRow(grid, ["Tier", "Leased", "Days-to-rent", "Peer", "Leased $", "Peer $"]);

    const tierRows = tiers
      .filter(function (t) { return t.bedroom_tier !== "overall"; })
      .filter(function (t) {
        // Show row only when competitors has lease data (so the comparison is meaningful)
        // OR the building has its own lease data (so we can show "your X leased at Y").
        return (t.peer_median_days_to_rent !== null && t.peer_median_days_to_rent !== undefined)
            || (t.median_days_to_rent !== null && t.median_days_to_rent !== undefined);
      });

    if (!tierRows.length) {
      const empty = createEl("div");
      empty.style.gridColumn = "1 / -1";
      empty.style.padding = "10px 0";
      empty.style.fontSize = "12px";
      empty.style.color = "var(--ink-soft)";
      empty.style.fontStyle = "italic";
      empty.textContent = "No leases observed in this competitors yet — comparison builds as listings transition.";
      grid.appendChild(empty);
    } else {
      tierRows.forEach(function (t) {
        appendVelocityRow(grid, t);
      });
    }

    wrap.appendChild(grid);
    return wrap;
  }

  function appendVelocityRow(grid, t) {
    const tierName = t.bedroom_tier === "studio" ? "Studio" : t.bedroom_tier + "BR";
    const cells = [
      tierName,
      String(t.leased_count_90d || 0),
      perfNum(t.median_days_to_rent),
      perfNum(t.peer_median_days_to_rent),
      perfMoney(t.median_leased_list_price),
      perfMoney(t.peer_median_leased_list_price),
    ];
    cells.forEach(function (val, i) {
      const cell = createEl("div");
      cell.textContent = val;
      cell.style.padding = "6px 0";
      cell.style.color = i === 0 ? "var(--ink-soft)" : "var(--ink)";
      cell.style.fontSize = i === 0 ? "11px" : "12px";
      cell.style.borderBottom = "1px solid var(--line)";
      cell.style.textAlign = i === 0 ? "left" : "right";
      grid.appendChild(cell);
    });
  }

  function buildCurrentlyAvailableTable(data, tiers, overall) {
    // spec-018d (revised): bottom sub-block. Includes own-DOM + peer-DOM as
    // a 4th-and-5th column so the dossier shows ALL four signals at a glance —
    // count, current-sitting time vs peer, asking price vs peer. Lease
    // velocity (the historical claim) lives in the top sub-block.
    const wrap = createEl("div");
    wrap.style.fontVariantNumeric = "tabular-nums";
    wrap.style.marginTop = "16px";
    wrap.style.paddingTop = "12px";
    wrap.style.borderTop = "1px solid var(--line)";

    wrap.appendChild(buildPerfSubBlockHeader("Currently available", null));

    const grid = createEl("div");
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "auto 1fr 1fr 1fr 1fr 1fr";
    grid.style.columnGap = "10px";
    grid.style.rowGap = "0";
    grid.style.fontSize = "12px";
    buildPerfHeaderRow(grid, ["Tier", "Available", "DOM", "Peer DOM", "Asking $", "Peer $"]);

    const tierRows = tiers
      .filter(function (t) { return t.bedroom_tier !== "overall"; })
      .filter(function (t) { return (t.active_units_in_tier || 0) > 0; });

    if (!tierRows.length) {
      const empty = createEl("div");
      empty.style.gridColumn = "1 / -1";
      empty.style.padding = "10px 0";
      empty.style.fontSize = "12px";
      empty.style.color = "var(--ink-soft)";
      empty.style.fontStyle = "italic";
      empty.textContent = "Fully occupied — no current openings.";
      grid.appendChild(empty);
    } else {
      tierRows.forEach(function (t) {
        appendAvailableRow(grid, t);
      });
    }

    wrap.appendChild(grid);

    // Overall availability footer (kept from spec-018c — useful at-a-glance).
    if (overall && overall.availability_ratio !== null
        && overall.availability_ratio !== undefined) {
      const avail = createEl("div");
      avail.style.display = "grid";
      avail.style.gridTemplateColumns = "auto 1fr auto";
      avail.style.columnGap = "10px";
      avail.style.fontSize = "12px";
      avail.style.fontVariantNumeric = "tabular-nums";
      avail.style.paddingTop = "10px";
      avail.style.marginTop = "6px";
      avail.style.borderTop = "1px solid var(--line)";

      const lbl = createEl("div", null, "Availability");
      lbl.style.fontSize = "10px";
      lbl.style.letterSpacing = "0.06em";
      lbl.style.textTransform = "uppercase";
      lbl.style.color = "var(--ink-faint)";

      const mid = createEl("div");
      mid.style.color = "var(--ink)";
      const ownPct = (overall.availability_ratio || 0) * 100;
      const peerPct = (overall.peer_median_availability_ratio || 0) * 100;
      mid.textContent = ownPct.toFixed(1) + "% (peer " + peerPct.toFixed(1) + "%)";

      const right = createEl("div");
      right.style.textAlign = "right";
      const dPp = (overall.availability_ratio_delta || 0) * 100;
      right.textContent = (dPp >= 0 ? "+" : "") + dPp.toFixed(1) + "pp";
      right.style.color = dPp >= 0 ? "var(--ink)" : "var(--ink-soft)";

      avail.appendChild(lbl);
      avail.appendChild(mid);
      avail.appendChild(right);
      wrap.appendChild(avail);
    }

    return wrap;
  }

  function appendAvailableRow(grid, t) {
    const tierName = t.bedroom_tier === "studio" ? "Studio" : t.bedroom_tier + "BR";
    const cells = [
      tierName,
      String(t.active_units_in_tier || 0),
      perfNum(t.median_dom),
      perfNum(t.peer_median_dom),
      perfMoney(t.median_price),
      perfMoney(t.peer_median_price),
    ];
    cells.forEach(function (val, i) {
      const cell = createEl("div");
      cell.textContent = val;
      cell.style.padding = "6px 0";
      cell.style.color = i === 0 ? "var(--ink-soft)" : "var(--ink)";
      cell.style.fontSize = i === 0 ? "11px" : "12px";
      cell.style.borderBottom = "1px solid var(--line)";
      cell.style.textAlign = i === 0 ? "left" : "right";
      grid.appendChild(cell);
    });
  }

  function appendPerfRow(grid, t) {
    // Retained for backward-compat with any legacy call sites (none after
    // spec-018d, but keeps the function available if something else grows
    // here later).
    const tierName = t.bedroom_tier === "studio" ? "Studio" : t.bedroom_tier + "BR";
    const cells = [
      tierName,
      String(t.active_units_in_tier || 0),
      perfNum(t.median_dom),
      perfNum(t.peer_median_dom),
      perfMoney(t.median_price),
      perfDelta(t.price_delta_pct, "%"),
    ];
    cells.forEach(function (val, i) {
      const cell = createEl("div");
      cell.textContent = val;
      cell.style.padding = "6px 0";
      cell.style.color = "var(--ink)";
      cell.style.borderBottom = "1px solid var(--line)";
      cell.style.textAlign = i === 0 ? "left" : "right";
      if (i === 0) {
        cell.style.fontSize = "11px";
        cell.style.color = "var(--ink-soft)";
      }
      grid.appendChild(cell);
    });
  }

  function perfNum(n) {
    if (n === null || n === undefined) return "—";
    return String(Math.round(Number(n)));
  }

  function perfMoney(n) {
    if (n === null || n === undefined) return "—";
    const v = Math.round(Number(n));
    return "$" + v.toLocaleString();
  }

  function perfDelta(n, suffix) {
    if (n === null || n === undefined) return "—";
    const v = Number(n);
    const sign = v >= 0 ? "+" : "";
    return sign + v.toFixed(1) + (suffix || "");
  }

  function pickTrajectoryTier(tiers) {
    // spec-018d: prefer the tier with the strongest absolute lease-velocity
    // delta first; fall back to the strongest active-DOM delta when no
    // velocity data exists. Final fallback: "1" (most populated tier).
    let best = null;
    let bestAbs = -Infinity;
    tiers.forEach(function (t) {
      if (t.bedroom_tier === "overall") return;
      const dd = t.days_to_rent_delta;
      if (dd === null || dd === undefined) return;
      const a = Math.abs(Number(dd));
      if (a > bestAbs) {
        bestAbs = a;
        best = t.bedroom_tier;
      }
    });
    if (best) return best;
    tiers.forEach(function (t) {
      if (t.bedroom_tier === "overall") return;
      const dd = t.dom_delta_days;
      if (dd === null || dd === undefined) return;
      const a = Math.abs(Number(dd));
      if (a > bestAbs) {
        bestAbs = a;
        best = t.bedroom_tier;
      }
    });
    return best || "1";
  }

  function buildPerfTrajectory(payload, tier) {
    // spec-023q: replaced the SVG sparkline with a one-line text
    // interpretation. Per user, the chart wasn't communicating its meaning
    // — a 2-point line with no axis labels and a generic "Trajectory" header
    // doesn't tell a broker anything they can act on. Instead, we summarize
    // the change between the two most-recent readings in plain English:
    //   "Studio days-to-rent up 12 days from last week (47 → 59) — trending worse.
    //    (Peer median: 21 days, unchanged.)"
    //
    // Hidden entirely when fewer than 2 weekly readings exist (a single
    // reading isn't a trend — that's just the current state, which the
    // tables above already show).
    const wrap = createEl("div");
    const history = (payload && Array.isArray(payload.history)) ? payload.history.slice() : [];
    if (history.length < 2) {
      // Single reading or none — say nothing here. The tables above already
      // surface the current values; an "only 1 reading" line is noise.
      return wrap;
    }
    history.sort(function (a, b) {
      return (a.measured_at || "") < (b.measured_at || "") ? -1 : 1;
    });

    const useVelocity = history.some(function (h) {
      return h && h.peer_median_days_to_rent !== null
          && h.peer_median_days_to_rent !== undefined;
    });
    const ownKey = useVelocity ? "median_days_to_rent" : "median_dom";
    const peerKey = useVelocity ? "peer_median_days_to_rent" : "peer_median_dom";
    const metricLabel = useVelocity ? "days-to-rent" : "active DOM";

    const tierLabel = tier === "studio" ? "Studio" : tier + "BR";

    const prev = history[history.length - 2];
    const curr = history[history.length - 1];
    const prevOwn = Number(prev[ownKey]);
    const currOwn = Number(curr[ownKey]);
    const prevPeer = Number(prev[peerKey]);
    const currPeer = Number(curr[peerKey]);

    if (!Number.isFinite(currOwn) || !Number.isFinite(prevOwn)) {
      return wrap;
    }

    const ownDelta = currOwn - prevOwn;
    const ownDir = ownDelta === 0 ? "unchanged"
      : ownDelta > 0 ? "up " + Math.round(ownDelta) + " days"
      : "down " + Math.round(-ownDelta) + " days";
    // For days-to-rent / DOM, UP = bad. We say so plainly.
    const verdict = ownDelta === 0 ? "stable"
      : ownDelta > 0 ? "trending worse"
      : "trending better";

    const header = createEl("div");
    header.style.fontSize = "10px";
    header.style.letterSpacing = "0.06em";
    header.style.textTransform = "uppercase";
    header.style.color = "var(--ink-faint)";
    header.style.marginBottom = "6px";
    header.textContent = "Trajectory · " + tierLabel + " " + metricLabel;
    wrap.appendChild(header);

    const main = createEl("div");
    main.style.fontSize = "12.5px";
    main.style.color = "var(--ink)";
    main.style.lineHeight = "1.5";
    main.appendChild(document.createTextNode(
      tierLabel + " " + metricLabel + " " + ownDir +
      " from last week (" + Math.round(prevOwn) + " → " + Math.round(currOwn) + ")"
    ));
    if (verdict !== "stable") {
      const v = createEl("span", null, " — " + verdict + ".");
      v.style.color = ownDelta > 0 ? "var(--ink)" : "var(--ink-soft)";
      v.style.fontWeight = "500";
      main.appendChild(v);
    } else {
      main.appendChild(document.createTextNode(" — stable."));
    }
    wrap.appendChild(main);

    // Peer reference line, smaller. Only show when we have data.
    if (Number.isFinite(currPeer)) {
      const peer = createEl("div");
      peer.style.fontSize = "11px";
      peer.style.color = "var(--ink-faint)";
      peer.style.marginTop = "3px";
      const peerNote = Number.isFinite(prevPeer) && prevPeer !== currPeer
        ? "Peer median: " + Math.round(currPeer) + " days (was " + Math.round(prevPeer) + ")."
        : "Peer median: " + Math.round(currPeer) + " days, unchanged.";
      peer.textContent = peerNote;
      wrap.appendChild(peer);
    }

    return wrap;
  }

  function miniRow(label, fillValue) {
    const row = createEl("div", "mini-row");
    row.appendChild(createEl("span", "mini-label", label));
    const val = createEl("span", "mini-value");
    fillValue(val);
    row.appendChild(val);
    return row;
  }

  // Inline-editable org row (Owner / Manager / Broker).
  // Click value → input. Enter / blur commits to ORG_OVERRIDES and re-renders.
  // Escape cancels. "—" placeholder stays editable (tap to add).
  function listingAgentRow(project) {
    const row = createEl("div", "mini-row");
    row.appendChild(createEl("span", "mini-label", "Listing agent"));
    const val = createEl("span", "mini-value");
    const agents = Array.isArray(project.listingAgents) ? project.listingAgents : [];
    if (!agents.length) {
      val.appendChild(createEl("span", "editable-text is-empty", "—"));
      val.title = "No listing agents on file (per source roster)";
    } else {
      // Each agent name is a click-to-promote button (spec-012). Names render
      // inline so the row stays compact; clicking opens the promotion form
      // anchored to the row.
      const tooltipLines = agents.map(function (a) {
        return (a.name || "—") + (a.phone ? " · " + a.phone : "");
      });
      // Use "; " — Chrome renders \n in title attrs but Safari may flatten,
      // so the cross-browser-safe separator is a literal delimiter.
      val.title = "Click an agent name to promote them as the decision maker. Source roster: " + tooltipLines.join("; ");
      const visibleAgents = agents.slice(0, 2);
      visibleAgents.forEach(function (agent, i) {
        if (!agent.name) return;
        const btn = createEl("button", "editable-text agent-promote");
        btn.type = "button";
        btn.textContent = agent.name;
        btn.title = "Promote " + agent.name + " as the decision maker on this building";
        btn.style.background = "transparent";
        btn.style.border = "none";
        btn.style.padding = "0";
        btn.style.color = "inherit";
        btn.style.font = "inherit";
        btn.style.cursor = "pointer";
        btn.style.textDecoration = "underline";
        btn.style.textDecorationStyle = "dotted";
        btn.style.textUnderlineOffset = "2px";
        btn.addEventListener("click", function (ev) {
          ev.stopPropagation();
          openDmPromotionForm(project, {name: agent.name, phone: agent.phone || ""}, row);
        });
        val.appendChild(btn);
        if (i < visibleAgents.length - 1) {
          val.appendChild(document.createTextNode(", "));
        }
      });
      if (agents.length > visibleAgents.length) {
        val.appendChild(document.createTextNode(" +" + (agents.length - visibleAgents.length)));
      }
    }
    row.appendChild(val);
    return row;
  }

  function editableOrgRow(project, label, role, payloadValue) {
    const row = createEl("div", "mini-row is-editable");
    row.appendChild(createEl("span", "mini-label", label));
    const val = createEl("span", "mini-value is-editable-val");
    const current = getOrgValue(project.project_id, role, payloadValue);
    const isEmpty = !current || current === "—";
    const displayText = isEmpty ? "Add " + label.toLowerCase() + "…" : current;
    const textNode = createEl("span", "editable-text" + (isEmpty ? " is-empty" : ""), displayText);
    const pencil = createEl("span", "editable-pencil", "✎");
    val.appendChild(textNode);
    val.appendChild(pencil);
    val.tabIndex = 0;
    val.title = "Click to edit";

    function enterEdit() {
      val.innerHTML = "";
      const input = document.createElement("input");
      input.type = "text";
      input.className = "editable-input";
      input.value = isEmpty ? "" : current;
      input.placeholder = "Organization name";
      val.appendChild(input);
      input.focus();
      input.select();
      let committed = false;
      function commit() {
        if (committed) return;
        committed = true;
        const v = input.value.trim();
        setOrgValue(project.project_id, role, v);
        renderDossier();
      }
      function cancel() {
        if (committed) return;
        committed = true;
        renderDossier();
      }
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") { e.preventDefault(); commit(); }
        else if (e.key === "Escape") { e.preventDefault(); cancel(); }
      });
      input.addEventListener("blur", commit);
    }
    val.addEventListener("click", enterEdit);
    val.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); enterEdit(); }
    });
    row.appendChild(val);
    return row;
  }

  function fubAvatar(name) {
    const initials = String(name || "").split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (part) { return part.charAt(0).toUpperCase(); }).join("") || "—";
    return createEl("span", "fub-avatar", initials);
  }
  function svgNode(pathBuilder) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("width", "11");
    svg.setAttribute("height", "11");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.1");
    pathBuilder(svg);
    return svg;
  }
  function makeEl(ns, tag, attrs) {
    const el = document.createElementNS(ns, tag);
    Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
    return el;
  }
  function iconFub() {
    return svgNode(function (svg) {
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "rect", { x: 1.5, y: 1.5, width: 9, height: 9 }));
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "path", { d: "M3.5 4 H 8.5 M3.5 6 H 7 M3.5 8 H 6" }));
    });
  }
  function iconCheck() {
    return svgNode(function (svg) {
      svg.setAttribute("stroke-width", "1.3");
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "polyline", { points: "2,6 5,9 10,3" }));
    });
  }
  function iconPerson() {
    return svgNode(function (svg) {
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "circle", { cx: 6, cy: 4, r: 2 }));
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "path", { d: "M2 11 C 2 8, 10 8, 10 11" }));
    });
  }
  function iconLink() {
    return svgNode(function (svg) {
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "path", { d: "M7 2 L 10 2 L 10 5 M10 2 L 5 7 M2 7 V 10 H 5 V 7 H 2" }));
    });
  }
  function iconClock() {
    return svgNode(function (svg) {
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "circle", { cx: 6, cy: 6, r: 4.5 }));
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "polyline", { points: "6,3.5 6,6 8.5,7" }));
    });
  }
  function iconRings() {
    return svgNode(function (svg) {
      svg.setAttribute("stroke-width", "1");
      const c = makeEl("http://www.w3.org/2000/svg", "circle", { cx: 6, cy: 6, r: 1.2 });
      c.setAttribute("fill", "currentColor");
      svg.appendChild(c);
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "circle", { cx: 6, cy: 6, r: 3 }));
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "circle", { cx: 6, cy: 6, r: 5 }));
    });
  }
  function iconArrow() {
    return svgNode(function (svg) {
      svg.setAttribute("viewBox", "0 0 12 12");
      svg.setAttribute("stroke-width", "1.3");
      svg.appendChild(makeEl("http://www.w3.org/2000/svg", "path", { d: "M2 6 H 10 M7 3 L 10 6 L 7 9" }));
    });
  }
  function editGlyph() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("width", "10");
    svg.setAttribute("height", "10");
    svg.setAttribute("class", "edit-glyph");
    const p = makeEl("http://www.w3.org/2000/svg", "path", { d: "M8 1 L11 4 L4 11 L1 11 L1 8 Z", fill: "none", stroke: "currentColor", "stroke-width": "0.8" });
    const l = makeEl("http://www.w3.org/2000/svg", "line", { x1: 7, y1: 2, x2: 10, y2: 5, stroke: "currentColor", "stroke-width": "0.8" });
    svg.appendChild(p);
    svg.appendChild(l);
    return svg;
  }
  function plusGlyph() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("class", "plus-glyph");
    svg.appendChild(makeEl("http://www.w3.org/2000/svg", "line", { x1: 6, y1: 2, x2: 6, y2: 10, stroke: "currentColor", "stroke-width": "0.9" }));
    svg.appendChild(makeEl("http://www.w3.org/2000/svg", "line", { x1: 2, y1: 6, x2: 10, y2: 6, stroke: "currentColor", "stroke-width": "0.9" }));
    return svg;
  }

  function updateMapState() {
    if (!map) {
      return;
    }

    const selected = getSelectedProject();

    markerById.forEach(function (marker, projectId) {
      const project = projectById.get(projectId);
      const isSelected = Boolean(selected && projectId === selected.project_id);
      const isHovered = hoveredId === projectId;
      const isMuted = Boolean(hoveredId && !isSelected && !isHovered);

      marker.setIcon(buildMarkerIcon(project, {
        selected: isSelected,
        hovered: isHovered,
        muted: isMuted
      }));
      const rankOffset = computeRankZ(project);
      marker.setZIndexOffset(isSelected ? 2000 + rankOffset : isHovered ? 1500 + rankOffset : rankOffset);

      if (isSelected || isHovered) {
        marker.setTooltipContent(buildTooltipContent(project, isSelected));
        marker.openTooltip();
      } else {
        marker.closeTooltip();
      }
    });
  }
}());
