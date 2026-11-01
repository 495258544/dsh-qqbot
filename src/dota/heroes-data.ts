/**
 * Dota2 英雄 ID → 简体中文名（静态数据，勿手改）
 * ─────────────────────────────────────────────────────────────
 * 来源：https://www.dota2.com/datafeed/herolist?language=schinese
 * 抓取时间：2026-10-31T14:04:18.531Z
 * 条数：127
 *
 * 为什么不运行时拉取：
 *   - 这份表一年只变几次（新英雄），而每次启动都请求一遍纯属浪费；
 *   - OpenDota 的 /constants/heroes 只给英文 localized_name，给不了中文；
 *     能出中文的只有 dota2.com 的 datafeed，那个站点慢且不在 OpenDota 的限流体系里。
 * 维护：加新英雄时重跑 .dsh-backup/dota-test/gen-heroes.mjs 覆盖本文件。
 *
 * ID 不连续（1..155 之间有空洞）是正常的：那些是已移除/预留的槽位。
 */

/** 英雄 ID → 中文名 */
export const HERO_NAMES: Record<number, string> = {
  1: '敌法师', // Anti-Mage · npc_dota_hero_antimage
  2: '斧王', // Axe · npc_dota_hero_axe
  3: '祸乱之源', // Bane · npc_dota_hero_bane
  4: '血魔', // Bloodseeker · npc_dota_hero_bloodseeker
  5: '水晶室女', // Crystal Maiden · npc_dota_hero_crystal_maiden
  6: '卓尔游侠', // Drow Ranger · npc_dota_hero_drow_ranger
  7: '撼地者', // Earthshaker · npc_dota_hero_earthshaker
  8: '主宰', // Juggernaut · npc_dota_hero_juggernaut
  9: '米拉娜', // Mirana · npc_dota_hero_mirana
  10: '变体精灵', // Morphling · npc_dota_hero_morphling
  11: '影魔', // Shadow Fiend · npc_dota_hero_nevermore
  12: '幻影长矛手', // Phantom Lancer · npc_dota_hero_phantom_lancer
  13: '帕克', // Puck · npc_dota_hero_puck
  14: '帕吉', // Pudge · npc_dota_hero_pudge
  15: '雷泽', // Razor · npc_dota_hero_razor
  16: '沙王', // Sand King · npc_dota_hero_sand_king
  17: '风暴之灵', // Storm Spirit · npc_dota_hero_storm_spirit
  18: '斯温', // Sven · npc_dota_hero_sven
  19: '小小', // Tiny · npc_dota_hero_tiny
  20: '复仇之魂', // Vengeful Spirit · npc_dota_hero_vengefulspirit
  21: '风行者', // Windranger · npc_dota_hero_windrunner
  22: '宙斯', // Zeus · npc_dota_hero_zuus
  23: '昆卡', // Kunkka · npc_dota_hero_kunkka
  25: '莉娜', // Lina · npc_dota_hero_lina
  26: '莱恩', // Lion · npc_dota_hero_lion
  27: '暗影萨满', // Shadow Shaman · npc_dota_hero_shadow_shaman
  28: '斯拉达', // Slardar · npc_dota_hero_slardar
  29: '潮汐猎人', // Tidehunter · npc_dota_hero_tidehunter
  30: '巫医', // Witch Doctor · npc_dota_hero_witch_doctor
  31: '巫妖', // Lich · npc_dota_hero_lich
  32: '力丸', // Riki · npc_dota_hero_riki
  33: '谜团', // Enigma · npc_dota_hero_enigma
  34: '修补匠', // Tinker · npc_dota_hero_tinker
  35: '狙击手', // Sniper · npc_dota_hero_sniper
  36: '瘟疫法师', // Necrophos · npc_dota_hero_necrolyte
  37: '术士', // Warlock · npc_dota_hero_warlock
  38: '兽王', // Beastmaster · npc_dota_hero_beastmaster
  39: '痛苦女王', // Queen of Pain · npc_dota_hero_queenofpain
  40: '剧毒术士', // Venomancer · npc_dota_hero_venomancer
  41: '虚空假面', // Faceless Void · npc_dota_hero_faceless_void
  42: '冥魂大帝', // Wraith King · npc_dota_hero_skeleton_king
  43: '死亡先知', // Death Prophet · npc_dota_hero_death_prophet
  44: '幻影刺客', // Phantom Assassin · npc_dota_hero_phantom_assassin
  45: '帕格纳', // Pugna · npc_dota_hero_pugna
  46: '圣堂刺客', // Templar Assassin · npc_dota_hero_templar_assassin
  47: '冥界亚龙', // Viper · npc_dota_hero_viper
  48: '露娜', // Luna · npc_dota_hero_luna
  49: '龙骑士', // Dragon Knight · npc_dota_hero_dragon_knight
  50: '戴泽', // Dazzle · npc_dota_hero_dazzle
  51: '发条技师', // Clockwerk · npc_dota_hero_rattletrap
  52: '拉席克', // Leshrac · npc_dota_hero_leshrac
  53: '自然先知', // Nature's Prophet · npc_dota_hero_furion
  54: '噬魂鬼', // Lifestealer · npc_dota_hero_life_stealer
  55: '黑暗贤者', // Dark Seer · npc_dota_hero_dark_seer
  56: '克林克兹', // Clinkz · npc_dota_hero_clinkz
  57: '全能骑士', // Omniknight · npc_dota_hero_omniknight
  58: '魅惑魔女', // Enchantress · npc_dota_hero_enchantress
  59: '哈斯卡', // Huskar · npc_dota_hero_huskar
  60: '暗夜魔王', // Night Stalker · npc_dota_hero_night_stalker
  61: '育母蜘蛛', // Broodmother · npc_dota_hero_broodmother
  62: '赏金猎人', // Bounty Hunter · npc_dota_hero_bounty_hunter
  63: '编织者', // Weaver · npc_dota_hero_weaver
  64: '杰奇洛', // Jakiro · npc_dota_hero_jakiro
  65: '蝙蝠骑士', // Batrider · npc_dota_hero_batrider
  66: '陈', // Chen · npc_dota_hero_chen
  67: '幽鬼', // Spectre · npc_dota_hero_spectre
  68: '远古冰魄', // Ancient Apparition · npc_dota_hero_ancient_apparition
  69: '末日使者', // Doom · npc_dota_hero_doom_bringer
  70: '熊战士', // Ursa · npc_dota_hero_ursa
  71: '裂魂人', // Spirit Breaker · npc_dota_hero_spirit_breaker
  72: '矮人直升机', // Gyrocopter · npc_dota_hero_gyrocopter
  73: '炼金术士', // Alchemist · npc_dota_hero_alchemist
  74: '祈求者', // Invoker · npc_dota_hero_invoker
  75: '沉默术士', // Silencer · npc_dota_hero_silencer
  76: '殁境神蚀者', // Outworld Devourer · npc_dota_hero_obsidian_destroyer
  77: '狼人', // Lycan · npc_dota_hero_lycan
  78: '酒仙', // Brewmaster · npc_dota_hero_brewmaster
  79: '暗影恶魔', // Shadow Demon · npc_dota_hero_shadow_demon
  80: '独行德鲁伊', // Lone Druid · npc_dota_hero_lone_druid
  81: '混沌骑士', // Chaos Knight · npc_dota_hero_chaos_knight
  82: '米波', // Meepo · npc_dota_hero_meepo
  83: '树精卫士', // Treant Protector · npc_dota_hero_treant
  84: '食人魔魔法师', // Ogre Magi · npc_dota_hero_ogre_magi
  85: '不朽尸王', // Undying · npc_dota_hero_undying
  86: '拉比克', // Rubick · npc_dota_hero_rubick
  87: '干扰者', // Disruptor · npc_dota_hero_disruptor
  88: '司夜刺客', // Nyx Assassin · npc_dota_hero_nyx_assassin
  89: '娜迦海妖', // Naga Siren · npc_dota_hero_naga_siren
  90: '光之守卫', // Keeper of the Light · npc_dota_hero_keeper_of_the_light
  91: '艾欧', // Io · npc_dota_hero_wisp
  92: '维萨吉', // Visage · npc_dota_hero_visage
  93: '斯拉克', // Slark · npc_dota_hero_slark
  94: '美杜莎', // Medusa · npc_dota_hero_medusa
  95: '巨魔战将', // Troll Warlord · npc_dota_hero_troll_warlord
  96: '半人马战行者', // Centaur Warrunner · npc_dota_hero_centaur
  97: '马格纳斯', // Magnus · npc_dota_hero_magnataur
  98: '伐木机', // Timbersaw · npc_dota_hero_shredder
  99: '钢背兽', // Bristleback · npc_dota_hero_bristleback
  100: '巨牙海民', // Tusk · npc_dota_hero_tusk
  101: '天怒法师', // Skywrath Mage · npc_dota_hero_skywrath_mage
  102: '亚巴顿', // Abaddon · npc_dota_hero_abaddon
  103: '上古巨神', // Elder Titan · npc_dota_hero_elder_titan
  104: '军团指挥官', // Legion Commander · npc_dota_hero_legion_commander
  105: '工程师', // Techies · npc_dota_hero_techies
  106: '灰烬之灵', // Ember Spirit · npc_dota_hero_ember_spirit
  107: '大地之灵', // Earth Spirit · npc_dota_hero_earth_spirit
  108: '孽主', // Underlord · npc_dota_hero_abyssal_underlord
  109: '恐怖利刃', // Terrorblade · npc_dota_hero_terrorblade
  110: '凤凰', // Phoenix · npc_dota_hero_phoenix
  111: '神谕者', // Oracle · npc_dota_hero_oracle
  112: '寒冬飞龙', // Winter Wyvern · npc_dota_hero_winter_wyvern
  113: '天穹守望者', // Arc Warden · npc_dota_hero_arc_warden
  114: '齐天大圣', // Monkey King · npc_dota_hero_monkey_king
  119: '邪影芳灵', // Dark Willow · npc_dota_hero_dark_willow
  120: '石鳞剑士', // Pangolier · npc_dota_hero_pangolier
  121: '天涯墨客', // Grimstroke · npc_dota_hero_grimstroke
  123: '森海飞霞', // Hoodwink · npc_dota_hero_hoodwink
  126: '虚无之灵', // Void Spirit · npc_dota_hero_void_spirit
  128: '电炎绝手', // Snapfire · npc_dota_hero_snapfire
  129: '玛尔斯', // Mars · npc_dota_hero_mars
  131: '百戏大王', // Ring Master · npc_dota_hero_ringmaster
  135: '破晓辰星', // Dawnbreaker · npc_dota_hero_dawnbreaker
  136: '玛西', // Marci · npc_dota_hero_marci
  137: '獸', // Primal Beast · npc_dota_hero_primal_beast
  138: '琼英碧灵', // Muerta · npc_dota_hero_muerta
  145: '凯', // Kez · npc_dota_hero_kez
  155: '朗戈', // Largo · npc_dota_hero_largo
};

/** 英雄 ID → 英文名（仅用于日志/排查，拿不到时为 undefined） */
export const HERO_NAMES_EN: Record<number, string> = {
  1: 'Anti-Mage',
  2: 'Axe',
  3: 'Bane',
  4: 'Bloodseeker',
  5: 'Crystal Maiden',
  6: 'Drow Ranger',
  7: 'Earthshaker',
  8: 'Juggernaut',
  9: 'Mirana',
  10: 'Morphling',
  11: 'Shadow Fiend',
  12: 'Phantom Lancer',
  13: 'Puck',
  14: 'Pudge',
  15: 'Razor',
  16: 'Sand King',
  17: 'Storm Spirit',
  18: 'Sven',
  19: 'Tiny',
  20: 'Vengeful Spirit',
  21: 'Windranger',
  22: 'Zeus',
  23: 'Kunkka',
  25: 'Lina',
  26: 'Lion',
  27: 'Shadow Shaman',
  28: 'Slardar',
  29: 'Tidehunter',
  30: 'Witch Doctor',
  31: 'Lich',
  32: 'Riki',
  33: 'Enigma',
  34: 'Tinker',
  35: 'Sniper',
  36: 'Necrophos',
  37: 'Warlock',
  38: 'Beastmaster',
  39: 'Queen of Pain',
  40: 'Venomancer',
  41: 'Faceless Void',
  42: 'Wraith King',
  43: 'Death Prophet',
  44: 'Phantom Assassin',
  45: 'Pugna',
  46: 'Templar Assassin',
  47: 'Viper',
  48: 'Luna',
  49: 'Dragon Knight',
  50: 'Dazzle',
  51: 'Clockwerk',
  52: 'Leshrac',
  53: 'Nature\'s Prophet',
  54: 'Lifestealer',
  55: 'Dark Seer',
  56: 'Clinkz',
  57: 'Omniknight',
  58: 'Enchantress',
  59: 'Huskar',
  60: 'Night Stalker',
  61: 'Broodmother',
  62: 'Bounty Hunter',
  63: 'Weaver',
  64: 'Jakiro',
  65: 'Batrider',
  66: 'Chen',
  67: 'Spectre',
  68: 'Ancient Apparition',
  69: 'Doom',
  70: 'Ursa',
  71: 'Spirit Breaker',
  72: 'Gyrocopter',
  73: 'Alchemist',
  74: 'Invoker',
  75: 'Silencer',
  76: 'Outworld Devourer',
  77: 'Lycan',
  78: 'Brewmaster',
  79: 'Shadow Demon',
  80: 'Lone Druid',
  81: 'Chaos Knight',
  82: 'Meepo',
  83: 'Treant Protector',
  84: 'Ogre Magi',
  85: 'Undying',
  86: 'Rubick',
  87: 'Disruptor',
  88: 'Nyx Assassin',
  89: 'Naga Siren',
  90: 'Keeper of the Light',
  91: 'Io',
  92: 'Visage',
  93: 'Slark',
  94: 'Medusa',
  95: 'Troll Warlord',
  96: 'Centaur Warrunner',
  97: 'Magnus',
  98: 'Timbersaw',
  99: 'Bristleback',
  100: 'Tusk',
  101: 'Skywrath Mage',
  102: 'Abaddon',
  103: 'Elder Titan',
  104: 'Legion Commander',
  105: 'Techies',
  106: 'Ember Spirit',
  107: 'Earth Spirit',
  108: 'Underlord',
  109: 'Terrorblade',
  110: 'Phoenix',
  111: 'Oracle',
  112: 'Winter Wyvern',
  113: 'Arc Warden',
  114: 'Monkey King',
  119: 'Dark Willow',
  120: 'Pangolier',
  121: 'Grimstroke',
  123: 'Hoodwink',
  126: 'Void Spirit',
  128: 'Snapfire',
  129: 'Mars',
  131: 'Ring Master',
  135: 'Dawnbreaker',
  136: 'Marci',
  137: 'Primal Beast',
  138: 'Muerta',
  145: 'Kez',
  155: 'Largo',
};
