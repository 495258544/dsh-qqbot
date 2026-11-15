/**
 * 装备名的官方简体中文对照（按 OpenDota `/constants/items` 的英文 dname 匹配）
 * ─────────────────────────────────────────────────────────────
 * 为什么需要（2026-11-16 实锤）：
 *   service.ts 里的 `itemName` 直接取 OpenDota 的 `dname`，**全是英文原名**。
 *   模型拿着英文名自己转述时翻了车：`Maelstrom`（漩涡）被说成「狂战斧」，
 *   而狂战斧是 `Battle Fury` —— 两件完全不同的装备，群里一眼就被看出来。
 *   这和技能名那类错译（God's Strength → 「众神之力」）是同一个毛病：
 *   让模型去"翻译"专有名词，必然有概率错，而错的是数据本身。
 *
 * 为什么只收一小张表、而不是全量中英对照：
 *   · 全量五百多条要跟版本维护，写错一条就是拿错误的中文覆盖正确的英文；
 *   · 没收录的装备**保留英文原名**，工具输出里也明说「照抄，禁止自己翻译」；
 *   · 输出格式是 `漩涡（Maelstrom）`，即使中文名有争议，群里也能靠英文对上号。
 *
 * 收录标准（只收**能确定**的 DOTA2 国服官方简体中文名）：
 *   · 基础组件、鞋类、热门中件/大件优先 —— 群聊里点评装备几乎只提这些；
 *   · 拿不准的一律不收（例：Point Booster、Boots of Bearing、Chasm Stone、Khanda
 *     这些要么译名有多个说法、要么是新版本装备还没稳定叫法）。
 *     宁可留英文，也不要造译名 —— 这张表的价值就是"绝不出错"。
 */

/**
 * key 必须与 OpenDota 的 `dname` **完全一致**（大小写敏感、含撇号与空格）。
 * 不做归一化：装备 dname 是稳定的官方英文名，归一化只会让"到底哪个 key 生效"变得模糊。
 */
export const ITEM_NAME_ZH: Record<string, string> = Object.freeze({
  // ── 消耗品 / 基础道具 ─────────────────────────────────────
  'Healing Salve': '治疗药膏',
  Clarity: '净化药水',
  'Faerie Fire': '仙灵之火',
  'Dust of Appearance': '显影之尘',
  'Smoke of Deceit': '诡计之雾',
  'Town Portal Scroll': '回城卷轴',
  Bottle: '瓶子',
  'Observer Ward': '侦查守卫',
  'Sentry Ward': '岗哨守卫',
  'Gem of True Sight': '真视宝石',
  'Tome of Knowledge': '知识之书',
  'Aegis of the Immortal': '不朽之守护',
  Cheese: '奶酪',
  'Infused Raindrops': '凝魂之泪',
  'Animal Courier': '动物信使',
  'Flying Courier': '飞行信使',

  // ── 属性 / 组件（最容易被模型乱译的一批）──────────────────
  'Iron Branch': '铁树枝干',
  'Quelling Blade': '补刀斧',
  'Blades of Attack': '攻击之爪',
  Broadsword: '宽剑',
  Claymore: '阔剑',
  'Mithril Hammer': '秘银锤',
  'Ogre Axe': '食人魔之斧',
  'Blade of Alacrity': '敏捷之刃',
  'Staff of Wizardry': '巫师之杖',
  Circlet: '头环',
  'Slippers of Agility': '敏捷便鞋',
  'Gauntlets of Strength': '力量手套',
  'Mantle of Intelligence': '智力斗篷',
  'Belt of Strength': '力量腰带',
  'Robe of the Magi': '法师长袍',
  'Ultimate Orb': '极限法球',
  'Mystic Staff': '神秘法杖',
  Reaver: '掠夺者之斧',
  Eaglesong: '鹰角弓',
  'Vitality Booster': '活力之球',
  'Energy Booster': '能量之球',
  'Soul Booster': '灵魂之球',
  'Ring of Health': '治疗指环',
  'Ring of Regen': '恢复指环',
  'Ring of Protection': '守护指环',
  'Ring of Basilius': '圣殿指环',
  'Ring of Aquila': '天鹰之戒',
  'Void Stone': '虚无宝石',
  Chainmail: '锁子甲',
  Platemail: '板甲',
  'Helm of Iron Will': '铁意头盔',
  'Gloves of Haste': '加速手套',
  'Wind Lace': '风铃',
  'Boots of Speed': '速度之靴',
  'Stout Shield': '圆盾',
  Quarterstaff: '短棍',
  'Oblivion Staff': '遗忘法杖',
  Perseverance: '坚韧球',
  'Shadow Amulet': '暗影护符',
  'Talisman of Evasion': '闪避护符',
  'Magic Wand': '魔杖',
  'Voodoo Mask': '巫毒面具',
  'Orb of Blight': '枯萎之石',
  'Orb of Venom': '毒液之球',
  'Orb of Frost': '冰霜之球',
  Hyperstone: '振奋宝石',
  Javelin: '标枪',
  Crown: '王冠',
  Cloak: '抗魔斗篷',
  'Sacred Relic': '圣者遗物',
  'Enchanted Mango': '魔法芒果',

  // ── 鞋类 ──────────────────────────────────────────────────
  'Power Treads': '动力鞋',
  'Phase Boots': '相位鞋',
  'Arcane Boots': '秘法鞋',
  'Tranquil Boots': '静谧之靴',
  'Boots of Travel': '远行鞋',
  'Guardian Greaves': '卫士胫甲',

  // ── 小件 / 前中期核心 ────────────────────────────────────
  'Soul Ring': '灵魂之戒',
  'Null Talisman': '无用挂件',
  Bracer: '护腕',
  'Wraith Band': '怨灵系带',
  'Armlet of Mordiggian': '莫尔迪基安的臂章',
  'Helm of the Dominator': '支配头盔',
  'Helm of the Overlord': '统御头盔',
  'Morbid Mask': '吸血面具',
  'Mask of Madness': '疯狂面具',
  'Hand of Midas': '迈达斯之手',
  'Drum of Endurance': '韧鼓',
  'Medallion of Courage': '勇气勋章',
  'Veil of Discord': '纷争面纱',
  Headdress: '头巾',
  'Holy Locket': '圣洁坠饰',
  'Urn of Shadows': '影之灵龛',
  'Spirit Vessel': '魂之灵瓮',
  "Vladmir's Offering": '弗拉迪米尔的祭品',

  // ── 功能件 / 保命 ────────────────────────────────────────
  'Blink Dagger': '闪烁匕首',
  'Force Staff': '原力法杖',
  'Hurricane Pike': '飓风长戟',
  'Dragon Lance': '魔龙枪',
  'Glimmer Cape': '微光披风',
  'Shadow Blade': '影刃',
  'Silver Edge': '白银之锋',
  'Ghost Scepter': '幽魂权杖',
  'Ethereal Blade': '虚灵之刃',
  'Aether Lens': '以太透镜',
  'Meteor Hammer': '陨星锤',
  'Echo Sabre': '回音战刃',
  'Mage Slayer': '法师克星',
  Vanguard: '先锋盾',
  'Crimson Guard': '赤红甲',
  'Hood of Defiance': '挑战头巾',
  'Pipe of Insight': '洞察烟斗',
  Mekansm: '梅肯斯姆',
  'Aghanim\'s Scepter': '阿哈利姆神杖',
  'Aghanim\'s Shard': '阿哈利姆魔晶',
  'Aghanim\'s Blessing': '阿哈利姆福佑',
  'Black King Bar': '黑皇杖',
  'Blade Mail': '刃甲',
  'Lotus Orb': '莲花',
  'Rod of Atos': '阿托斯之棍',
  'Linken\'s Sphere': '林肯法球',
  'Scythe of Vyse': '邪恶镰刀',
  'Heaven\'s Halberd': '天堂之戟',
  'Aeon Disk': '永恒之盘',
  'Solar Crest': '炎阳纹章',
  Harpoon: '鱼叉',
  'Orb of Corrosion': '腐蚀之球',
  'Moon Shard': '银月之晶',
  'Ring of Tarrasque': '恐鳌之戒',

  // ── 属性三件套 / 分身 ────────────────────────────────────
  Sange: '散华',
  Yasha: '夜叉',
  Kaya: '卡雅',
  'Sange and Yasha': '散华与夜叉',
  'Kaya and Sange': '卡雅与散华',
  'Yasha and Kaya': '夜叉与卡雅',
  'Manta Style': '幻影斧',
  'Diffusal Blade': '净魂之刃',

  // ── 输出装（Maelstrom / Battle Fury 这一组是错译重灾区）──
  Maelstrom: '漩涡',
  Mjollnir: '雷神之锤',
  'Battle Fury': '狂战斧',
  Desolator: '黯灭',
  Crystalys: '水晶剑',
  Daedalus: '代达罗斯之殇',
  'Demon Edge': '恶魔刀锋',
  'Monkey King Bar': '金箍棒',
  'Skull Basher': '碎颅锤',
  'Abyssal Blade': '深渊之刃',
  'Divine Rapier': '圣剑',
  Radiance: '辉耀',
  Butterfly: '蝴蝶',
  'Assault Cuirass': '强袭胸甲',
  'Shiva\'s Guard': '希瓦的守护',
  'Heart of Tarrasque': '恐鳌之心',
  'Eye of Skadi': '斯嘉蒂之眼',
  Satanic: '撒旦之邪力',
  'Orchid Malevolence': '紫怨',
  Bloodthorn: '血棘',
  Dagon: '达贡之神力',
  Necronomicon: '死灵书',
  Bloodstone: '血精石',
  'Refresher Orb': '刷新球',
  'Octarine Core': '玲珑心',
});

/**
 * 查官方简体中文名；没收录返回 undefined（调用方保留英文原名）。
 * 只认 dname 精确匹配：装备名没有"同一件多个写法"的问题，模糊匹配只会引入误判
 * （`Dagon` 与 `Dagon Recipe` 这类名字前缀相同，真做前缀匹配就会把配方当成装备）。
 */
export function itemNameZh(en: string): string | undefined {
  const key = typeof en === 'string' ? en.trim() : '';
  return key === '' ? undefined : ITEM_NAME_ZH[key];
}
