-- orrery: connects a Factorio server to orrery's hub, through the agent on the server's host.
--
-- Mod to agent: one JSON datagram per event, helpers.send_udp(AGENT_PORT, json, 0), sent by the server only.
-- Agent to mod: the console commands below, over RCON, each answering with one JSON line through rcon.print.
-- The packets and replies are listed in CLAUDE.md (not shipped in the zip).
--
-- Every command and event handler runs in pcall: an uncaught error in a handler ends the server with exit 255 and
-- no save (verified on 2.1.24). A command answers its error as JSON; an event handler logs it and drops the event.

local AGENT_PORT = 34199 -- the agent's UDP listener on 127.0.0.1; Factorio sends from its --enable-lua-udp port
local MAX_PACKET = 4096 -- bytes of JSON per datagram; the agent drops anything larger
local MAX_NAME = 64 -- the hub's limit for player names
local MAX_MESSAGE = 1000 -- the hub's limit for chat messages is 1 KiB
local MAX_TEXT = 200 -- the hub caps a milestone's text at 200 characters
local ZWSP = "\226\128\139" -- U+200B, put after every "[" of outside text so it cannot render as rich text

local BLUE = { r = 0.4, g = 0.55, b = 1 }
local GOLD = { r = 1, g = 0.67, b = 0 }
local YELLOW = { r = 1, g = 1, b = 0.33 }
local GREEN = { r = 0.33, g = 1, b = 0.33 }
local RED = { r = 1, g = 0.33, b = 0.33 }

local reasons = {} -- defines.disconnect_reason value -> its name ("quit", "dropped", "kicked", ...)
for name, value in pairs(defines.disconnect_reason) do
  reasons[value] = name
end

--- The first n bytes of s, cut back to a UTF-8 character boundary.
local function cut(s, n)
  if #s <= n then return s end
  while n > 0 do
    local b = s:byte(n + 1)
    if b < 0x80 or b >= 0xC0 then break end
    n = n - 1
  end
  return s:sub(1, n)
end

--- Outside text as plain text: a "[" followed by U+200B starts no rich-text tag ([color=...], [img=...], [gps=...]).
local function plain(s)
  return (s:gsub("%[", "[" .. ZWSP))
end

--- An internal name for people: "mining-productivity" -> "Mining productivity", "vulcanus" -> "Vulcanus".
local function pretty(name)
  local s = name:gsub("[-_]", " ")
  return (s:gsub("^%l", string.upper))
end

--- A finished research as posted: its name, and for a levelled (infinite) technology the level it finished.
local function research_name(tech)
  local proto = tech.prototype
  if proto.max_level <= proto.level then return pretty(tech.name) end
  -- When the event fires, tech.level is already the next level (verified on 2.1.24: finishing mining productivity
  -- 3 reads 4), unless that was the last level and the technology is now researched.
  local level = tech.researched and tech.level or tech.level - 1
  -- Levelled technologies are named for their first level ("mining-productivity-3"); the level replaces it.
  local base = tech.name:gsub("%-" .. proto.level .. "$", "")
  return pretty(base) .. " " .. level
end

-- Mod to agent ------------------------------------------------------------------------------------------------------

--- Sends one event to the agent with the next seq. `long` names the free-text field that is shortened, on a
--- character boundary, until the JSON fits in MAX_PACKET; an event that still does not fit is dropped and logged.
local function send(evt, long)
  local json
  while true do
    evt.seq = storage.seq + 1
    json = helpers.table_to_json(evt)
    if #json <= MAX_PACKET then break end
    if not long or #evt[long] == 0 then
      log("orrery: dropped a " .. evt.t .. " event of " .. #json .. " bytes")
      return
    end
    evt[long] = cut(evt[long], math.floor(#evt[long] / 2))
  end
  storage.seq = evt.seq
  helpers.send_udp(AGENT_PORT, json, 0)
end

local function name_of(player)
  return cut(player.name, MAX_NAME)
end

--- The force's name for a milestone, or nil for the default force "player" (the hub shows a force only when set).
local function force_of(force)
  if force.name == "player" then return nil end
  return cut(force.name, MAX_NAME)
end

local function milestone(kind, text, force, player)
  send({
    t = "milestone",
    kind = kind,
    text = cut(text, MAX_TEXT),
    force = force_of(force),
    player = player and name_of(player) or nil,
  }, "text")
end

-- Firsts --------------------------------------------------------------------------------------------------------------
-- storage.firsts[force name] = { rocket = true, platform = true, landing = { [planet name] = true } }

local function firsts_of(force)
  local f = storage.firsts[force.name]
  if not f then
    f = { landing = {} }
    storage.firsts[force.name] = f
  end
  return f
end

--- Marks what the map already has as done, so adding the mod to an existing save posts no stale firsts: a force's
--- launched rockets, its platforms, Nauvis, and every planet a player stands on. It only ever adds.
local function seed()
  for _, force in pairs(game.forces) do
    local f = firsts_of(force)
    if force.rockets_launched > 0 then f.rocket = true end
    if #force.platforms > 0 then f.platform = true end
    f.landing.nauvis = true
  end
  for _, player in pairs(game.players) do
    local planet = player.physical_surface.planet
    if planet then firsts_of(player.force).landing[planet.name] = true end
  end
end

--- A player is physically on a planet their force has not landed on before: post it once.
local function landed(player)
  local planet = player.physical_surface.planet -- the physical surface, so remote view never counts
  if not planet then return end
  local f = firsts_of(player.force)
  if f.landing[planet.name] then return end
  f.landing[planet.name] = true
  milestone("landing", pretty(planet.name), player.force, player)
end

-- Setup ---------------------------------------------------------------------------------------------------------------

local function setup()
  storage.seq = storage.seq or 0
  storage.firsts = storage.firsts or {}
  seed()
end

local function guarded(what, fn)
  return function(e)
    local ok, err = pcall(fn, e)
    if not ok then log("orrery: " .. what .. " failed: " .. tostring(err)) end
  end
end

script.on_init(guarded("on_init", setup))
script.on_configuration_changed(guarded("on_configuration_changed", setup))
-- Nothing in on_load: storage and the game are read-only there.

-- Events --------------------------------------------------------------------------------------------------------------

local function on(event, fn)
  script.on_event(defines.events[event], guarded(event, fn))
end

on("on_console_chat", function(e)
  -- No player: plain text from the server console or RCON (an admin on the dashboard). It never reaches Discord.
  if not e.player_index then return end
  local player = game.get_player(e.player_index)
  if not player then return end
  send({ t = "chat", player = name_of(player), message = cut(e.message, MAX_MESSAGE) }, "message")
end)

on("on_player_joined_game", function(e)
  send({ t = "join", player = name_of(game.get_player(e.player_index)) })
end)

on("on_player_left_game", function(e)
  send({ t = "leave", player = name_of(game.get_player(e.player_index)), reason = reasons[e.reason] })
end)

on("on_player_died", function(e)
  local evt = { t = "death", player = name_of(game.get_player(e.player_index)) }
  local cause = e.cause
  if cause and cause.valid then
    evt.cause = cut(cause.name, MAX_NAME)
    -- LuaEntity.player exists only on characters; reading it on any other entity raises.
    if cause.type == "character" and cause.player then evt.killer = name_of(cause.player) end
  end
  send(evt)
end)

on("on_research_finished", function(e)
  -- by_script: a mod's unlocks, research_recursive and console cheats. Only research done in labs is posted.
  if e.by_script then return end
  local tech = e.research
  milestone("research", research_name(tech), tech.force)
end)

on("on_cargo_pod_finished_ascending", function(e)
  if not e.launched_by_rocket then return end
  local pod = e.cargo_pod
  local f = firsts_of(pod.force)
  if f.rocket then return end
  f.rocket = true
  local planet = pod.surface.planet
  milestone("rocket", planet and pretty(planet.name) or "", pod.force)
end)

on("on_space_platform_changed_state", function(e)
  if e.old_state ~= defines.space_platform_state.starter_pack_on_the_way then return end
  local platform = e.platform
  local f = firsts_of(platform.force)
  if f.platform then return end
  f.platform = true
  milestone("platform", platform.name, platform.force)
end)

on("on_cargo_pod_finished_descending", function(e)
  if not e.player_index then return end
  landed(game.get_player(e.player_index))
end)

on("on_player_changed_surface", function(e)
  landed(game.get_player(e.player_index))
end)

-- Commands ------------------------------------------------------------------------------------------------------------

local function reply(t)
  rcon.print(helpers.table_to_json(t))
end

--- A command for the agent over RCON (or the server console). A player typing it gets nothing. Its function returns
--- the reply table, or raises; either way exactly one JSON line goes back.
local function console(name, fn)
  commands.add_command(name, { "command-help." .. name }, function(e)
    if e.player_index ~= nil then return end
    local ok, result = pcall(fn, e.parameter)
    if not ok then
      log("orrery: /" .. name .. " failed: " .. tostring(result))
      result = { ok = false, error = tostring(result) }
    end
    pcall(reply, result)
  end)
end

--- A command for players. Over RCON it answers an error, since it needs a player to name.
local function for_players(name, fn)
  commands.add_command(name, { "command-help." .. name }, function(e)
    if e.player_index == nil then
      pcall(reply, { ok = false, error = "/" .. name .. " is for players" })
      return
    end
    local ok, err = pcall(function()
      -- The player's name comes from their own index, never from the command's text.
      fn(game.get_player(e.player_index), e.parameter)
    end)
    if not ok then log("orrery: /" .. name .. " failed: " .. tostring(err)) end
  end)
end

--- The command's parameter as a JSON object, with each named field a string; raises with a short reason otherwise.
local function object(parameter, ...)
  local t = parameter and helpers.json_to_table(parameter)
  if type(t) ~= "table" then error("want a JSON object", 0) end
  for _, field in ipairs({ ... }) do
    if type(t[field]) ~= "string" then error("want a string " .. field, 0) end
  end
  return t
end

-- {author, message, source}: a chat line from Discord, or from the dashboard when source is "dashboard".
console("orrery-say", function(parameter)
  local t = object(parameter, "author", "message")
  local dashboard = t.source == "dashboard"
  game.print((dashboard and "[Dashboard] <" or "[Discord] <") .. plain(t.author) .. "> " .. plain(t.message), {
    color = dashboard and GOLD or BLUE,
    skip = defines.print_skip.never,
  })
  return { ok = true }
end)

-- {message}: a system line from the hub, such as a restart countdown.
console("orrery-notice", function(parameter)
  local t = object(parameter, "message")
  game.print(plain(t.message), { color = YELLOW, skip = defines.print_skip.never })
  return { ok = true }
end)

-- {player, ok, message}: the answer to a /orrery-link or /orrery-unlink, shown to that player only.
console("orrery-reply", function(parameter)
  local t = object(parameter, "player", "message")
  local player = game.get_player(t.player)
  if not (player and player.connected) then error("not online: " .. t.player, 0) end
  player.print("[Discord] " .. plain(t.message), { color = t.ok == true and GREEN or RED, skip = defines.print_skip.never })
  return { ok = true }
end)

console("orrery-status", function()
  local players = {}
  for _, player in pairs(game.connected_players) do
    players[#players + 1] = player.name
  end
  return {
    ok = true,
    tick = game.tick,
    tick_paused = game.tick_paused,
    players = players,
    version = helpers.game_version,
    mods = script.active_mods,
    loaded = storage.seq ~= nil,
  }
end)

-- <name>: saves the map as saves/<name>.zip. Plain names only, never one of Factorio's _autosave files.
console("orrery-save", function(parameter)
  local name = parameter and parameter:match("^%s*(.-)%s*$") or ""
  if #name > 100 or not name:match("^[%w][%w._-]*$") then error("want a save name of letters, digits, . _ -", 0) end
  game.server_save(name)
  return { ok = true, name = name }
end)

-- <CODE>: redeems the code that /link gave in Discord. The hub answers through /orrery-reply.
for_players("orrery-link", function(player, parameter)
  local code = parameter and parameter:match("^%s*(%w+)%s*$")
  if not code or #code > 16 then
    player.print({ "orrery.link-usage" }, { color = RED })
    return
  end
  send({ t = "link", player = name_of(player), code = code })
  player.print({ "orrery.linking" }, { color = GREEN })
end)

for_players("orrery-unlink", function(player)
  send({ t = "unlink", player = name_of(player) })
end)
