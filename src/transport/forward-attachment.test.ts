/**
 * 合并转发内图片附件：从文本里捞 URL + 保留「第几条」编号。
 *
 * 样本来自 2026-11-09 真实群消息（debug-inbound.jsonl，msgType=103）：
 * 顶层 attachments 为空，图片 URL 只存在于 msgElements[0].content。
 */
import { describe, it, expect } from 'vitest';
import { extractForwardAttachmentRefs } from './attachment.ts';
import { buildQuotePart } from './inbound.ts';

const PNG = '44BDC84BC82745A8E3159B93FA173912.png';
const JPG = '2259B57C153D7841B51AAE5C0DD4D786.jpg';
const url = (fileid: string) =>
  `https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=${fileid}&rkey=KEY_${fileid}&spec=0`;

const REAL_FORWARD = [
  '=== 消息 1 ===',
  '[消息类型] 引用消息',
  `[附件1] 类型:图片 文件名:${PNG} 尺寸:960x1050 大小:1.5MB URL:${url('A')}`,
  '',
  '=== 消息 2 ===',
  '[消息内容] 图还是没进来，只收到「这个呢」三个字。',
  '',
  '=== 消息 3 ===',
  '[消息内容]     你们看得到图片吗？',
  '[关联消息]',
  '--- 第1条 ---',
  '    [发送者] ……',
  `    [附件1] 类型:图片 文件名:${JPG} 尺寸:940x924 大小:92.2KB URL:${url('B')}`,
  '',
  '=== 消息 4 ===',
  '[消息内容]   小羽看得到图片吗',
  '[关联消息]',
  '--- 第1条 ---',
  `    [附件1] 类型:图片 文件名:${JPG} 尺寸:940x924 大小:92.2KB URL:${url('C')}`,
  '',
  '=== 消息 5 ===',
  '[消息内容] 这条转发里看不到，图片都只是个[图片]占位。',
  '',
  '=== 消息 6 ===',
  `[附件1] 类型:图片 文件名:${PNG} 尺寸:960x1050 大小:1.5MB URL:${url('D')}`,
].join('\n');

describe('extractForwardAttachmentRefs · 合并转发内图片', () => {
  it('真实样本：捞到 URL，按文件名去重，保留首次出现的消息编号', () => {
    const refs = extractForwardAttachmentRefs(REAL_FORWARD);
    expect(refs).toHaveLength(2);
    expect(refs.map(r => [r.nodeIndex, r.filename])).toEqual([[1, PNG], [3, JPG]]);
    expect(refs[0]!.url).toBe(url('A'));
    expect(refs[0]!.contentType).toBe('image/png');
  });

  it('[关联消息] 里的附件归到所在那条消息，不会被算成下一条', () => {
    const refs = extractForwardAttachmentRefs(REAL_FORWARD);
    expect(refs.find(r => r.filename === JPG)?.nodeIndex).toBe(3);
  });

  it('没有编号头时统一算第 1 条', () => {
    const refs = extractForwardAttachmentRefs(
      `[附件1] 类型:图片 文件名:${PNG} 尺寸:1x1 大小:1KB URL:${url('X')}`,
    );
    expect(refs).toHaveLength(1);
    expect(refs[0]!.nodeIndex).toBe(1);
  });

  it('非图片/视频保留 file 类型', () => {
    const refs = extractForwardAttachmentRefs(
      `[附件1] 类型:文件 文件名:note.txt 大小:1KB URL:${url('F')}`,
    );
    expect(refs[0]!.contentType).toBe('application/octet-stream');
  });

  it('拒绝内网/本机/非 http(s) URL（转发文本是用户可控内容）', () => {
    const bad = [
      'http://127.0.0.1/admin',
      'http://192.168.1.1/x',
      'http://10.0.0.5/x',
      'file:///C:/Windows/win.ini',
      'javascript:alert(1)',
    ];
    for (const u of bad) {
      expect(extractForwardAttachmentRefs(`[附件1] 类型:图片 文件名:x.png URL:${u}`)).toEqual([]);
    }
  });

  it('最多只取 max 个，避免整屏转发打满流量', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      `[附件1] 类型:图片 文件名:file${i}.png URL:${url(String(i))}`).join('\n');
    expect(extractForwardAttachmentRefs(many)).toHaveLength(8);
    expect(extractForwardAttachmentRefs(many, 3)).toHaveLength(3);
  });

  it('没有附件标记时返回空', () => {
    expect(extractForwardAttachmentRefs('=== 消息 1 ===\n[消息内容] 纯文字')).toEqual([]);
    expect(extractForwardAttachmentRefs('')).toEqual([]);
  });
});

describe('buildQuotePart · 转发图锚点', () => {
  const quote = {
    text: [
      '=== 消息 1 ===',
      `[附件1] 类型:图片 文件名:${PNG} 尺寸:960x1050 大小:1.5MB URL:${url('A')}`,
      '',
      '=== 消息 2 ===',
      '[消息内容] 这是另一条，说的是别的事',
    ].join('\n'),
  };

  it('下载成功的那条挂 #N，和 Forward images 编号对上', () => {
    const out = buildQuotePart(quote, [], undefined, undefined, undefined, [1]);
    expect(out).toContain('[图片 #1]');
  });

  it('没下载成功的条不挂编号（不给她不存在的图指路）', () => {
    const out = buildQuotePart(quote, [], undefined, undefined, undefined, []);
    expect(out).toContain('[图片]');
    expect(out).not.toContain('#1');
  });

  it('不传新参数时行为与旧版一致（老调用方不受影响）', () => {
    expect(buildQuotePart(quote)).toContain('[图片]');
    expect(buildQuotePart(quote)).not.toContain('#1');
  });
});
