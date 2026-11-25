'use strict';
/* 教学演示数据包：完整的课堂经营样本（菜单 / 桌台 / 订单 / 会员券 / 日志）。
   仅由教师端只读演示接口使用，不写入任何学生账号，也不进入真实业务库。 */

const CATS = ['热菜', '素菜', '凉菜', '汤羹', '主食', '饮品', '甜点'];
const MENU = [
  {id: 'm01', name: '招牌红烧肉', cat: '热菜', price: 68, cost: 26, unit: '份', emoji: '🍖', desc: '五花三层，慢火收汁', stock: 40, soldOut: false},
  {id: 'm02', name: '清蒸鲈鱼', cat: '热菜', price: 98, cost: 42, unit: '条', emoji: '🐟', desc: '现杀活鱼，豉油提鲜', stock: 18, soldOut: false, specs: [{n: '整条'}, {n: '半条'}], specPrice: {整条: 98, 半条: 58}},
  {id: 'm03', name: '宫保鸡丁', cat: '热菜', price: 42, cost: 16, unit: '份', emoji: '🍗', desc: '荔枝口，微辣回甜', stock: 45, soldOut: false},
  {id: 'm04', name: '麻婆豆腐', cat: '热菜', price: 28, cost: 9, unit: '份', emoji: '🌶️', desc: '麻辣鲜香，下饭首选', stock: 60, soldOut: false},
  {id: 'm05', name: '干锅花菜', cat: '热菜', price: 36, cost: 13, unit: '份', emoji: '🥦', desc: '腊肉同炒，锅气十足', stock: 40, soldOut: false},
  {id: 'm06', name: '蒜蓉西兰花', cat: '素菜', price: 26, cost: 8, unit: '份', emoji: '🥬', desc: '清甜脆嫩，少油少盐', stock: 50, soldOut: false},
  {id: 'm07', name: '凉拌黄瓜', cat: '凉菜', price: 18, cost: 6, unit: '份', emoji: '🥒', desc: '拍蒜香醋，爽口开胃', stock: 60, soldOut: false},
  {id: 'm08', name: '口水鸡', cat: '凉菜', price: 38, cost: 15, unit: '份', emoji: '🍗', desc: '红油藤椒，麻辣鲜嫩', stock: 30, soldOut: false},
  {id: 'm09', name: '番茄蛋汤', cat: '汤羹', price: 22, cost: 7, unit: '例', emoji: '🍅', desc: '家常暖胃，酸甜适口', stock: 40, soldOut: false},
  {id: 'm10', name: '菌菇老鸭汤', cat: '汤羹', price: 48, cost: 18, unit: '盅', emoji: '🍲', desc: '文火慢煨，汤色清亮', stock: 24, soldOut: false},
  {id: 'm11', name: '扬州炒饭', cat: '主食', price: 32, cost: 10, unit: '份', emoji: '🍚', desc: '粒粒分明，配料扎实', stock: 45, soldOut: false},
  {id: 'm12', name: '手工阳春面', cat: '主食', price: 18, cost: 5, unit: '碗', emoji: '🍜', desc: '猪油葱花，汤清面劲', stock: 50, soldOut: false},
  {id: 'm13', name: '鲜榨橙汁', cat: '饮品', price: 22, cost: 7, unit: '杯', emoji: '🍊', desc: '当日鲜榨，无添加', stock: 30, soldOut: false},
  {id: 'm14', name: '红糖糍粑', cat: '甜点', price: 26, cost: 9, unit: '份', emoji: '🍡', desc: '外酥内糯，红糖拉丝', stock: 30, soldOut: false}
];
const MENU_BY_ID = Object.fromEntries(MENU.map(d => [d.id, d]));
const PAY = {wx: '微信支付', zfb: '支付宝', cash: '现金', credit: '信用卡', debit: '储蓄卡', meituan: '美团团购', dianping: '大众点评团购'};
const VOUCHER = {meituan: 0.8, dianping: 0.85};

function item(id, qty, spec, mods) {
  const d = MENU_BY_ID[id], useSpec = spec || (d.specs ? d.specs[0].n : '');
  const price = useSpec && d.specPrice && d.specPrice[useSpec] != null ? d.specPrice[useSpec] : d.price;
  return {name: d.name + (useSpec ? '（' + useSpec + '）' : ''), price, qty, mods: mods || [], dishId: id, cost: d.cost};
}

/* 营业数据样本：覆盖新下单 / 制作中 / 已出餐待结账 / 已结账四种状态与七种支付方式 */
const SAMPLE = [
  ['A01', 11, 12, 'paid', 'wx', [['m01', 1], ['m04', 1], ['m11', 1]], 2, '不要葱'],
  ['A01', 11, 48, 'paid', 'zfb', [['m02', 1, '整条'], ['m06', 1], ['m13', 2]], 4, '鱼要蒸嫩一点'],
  ['A02', 12, 6, 'paid', 'meituan', [['m03', 1], ['m07', 1], ['m12', 2]], 2, '团购券已核销'],
  ['A02', 12, 31, 'paid', 'cash', [['m05', 1], ['m09', 1], ['m11', 1]], 3, ''],
  ['A03', 12, 55, 'paid', 'credit', [['m01', 1], ['m08', 1], ['m10', 1], ['m14', 1]], 4, '宴请，先上凉菜'],
  ['A03', 13, 18, 'paid', 'wx', [['m04', 2], ['m09', 1], ['m11', 2]], 5, '加辣'],
  ['A04', 13, 40, 'paid', 'dianping', [['m02', 1, '半条'], ['m03', 1], ['m06', 1], ['m13', 1]], 2, '点评套餐'],
  ['A04', 14, 5, 'paid', 'debit', [['m05', 1], ['m08', 1], ['m12', 2]], 3, ''],
  ['A05', 14, 32, 'paid', 'wx', [['m01', 1], ['m03', 1], ['m04', 1], ['m11', 1], ['m13', 2]], 6, '家庭聚餐'],
  ['A05', 15, 8, 'paid', 'zfb', [['m10', 2], ['m14', 2]], 4, '汤要热'],
  ['A06', 15, 36, 'paid', 'meituan', [['m03', 1], ['m05', 1], ['m09', 1], ['m12', 1]], 2, ''],
  ['A06', 16, 2, 'paid', 'cash', [['m04', 1], ['m06', 1], ['m11', 1], ['m13', 1]], 3, '免葱免蒜'],
  ['A07', 16, 35, 'paid', 'credit', [['m01', 2], ['m02', 1, '整条'], ['m08', 1], ['m10', 1], ['m14', 1]], 8, '生日聚餐，上菜慢一点'],
  ['A07', 17, 10, 'paid', 'wx', [['m03', 1], ['m05', 1], ['m07', 1], ['m11', 1]], 3, ''],
  ['A08', 17, 45, 'paid', 'zfb', [['m02', 1, '半条'], ['m04', 1], ['m09', 1], ['m12', 1]], 2, ''],
  ['A08', 18, 16, 'paid', 'dianping', [['m01', 1], ['m06', 1], ['m13', 2], ['m14', 1]], 2, '点评双人餐'],
  ['A01', 18, 42, 'paid', 'wx', [['m05', 1], ['m08', 1], ['m11', 1]], 3, ''],
  ['A02', 19, 5, 'paid', 'cash', [['m03', 2], ['m04', 1], ['m12', 2]], 4, '现金找零已备'],
  ['A03', 19, 28, 'done', '', [['m01', 1], ['m06', 1], ['m09', 1]], 2, '已出餐，待收银'],
  ['A04', 19, 41, 'done', '', [['m02', 1, '整条'], ['m03', 1], ['m13', 1]], 3, '待结账'],
  ['A05', 19, 52, 'done', '', [['m05', 1], ['m08', 1], ['m11', 1], ['m14', 1]], 4, '客人还在聊天'],
  ['A06', 20, 3, 'done', '', [['m04', 1], ['m07', 1], ['m12', 1]], 2, ''],
  ['A07', 20, 12, 'cooking', '', [['m01', 1], ['m03', 1], ['m10', 1]], 3, '少油少盐'],
  ['A08', 20, 18, 'cooking', '', [['m02', 1, '半条'], ['m06', 1], ['m09', 1]], 2, '加急'],
  ['A01', 20, 24, 'cooking', '', [['m05', 1], ['m11', 1], ['m13', 1]], 2, ''],
  ['A02', 20, 29, 'cooking', '', [['m03', 1], ['m04', 1], ['m12', 1], ['m14', 1]], 3, '免蒜'],
  ['A03', 20, 33, 'new', '', [['m01', 1], ['m02', 1, '半条'], ['m08', 1], ['m11', 1]], 5, '扫码刚下单'],
  ['A04', 20, 36, 'new', '', [['m06', 1], ['m09', 1], ['m13', 1]], 2, ''],
  ['A05', 20, 39, 'new', '', [['m05', 1], ['m07', 1], ['m12', 1]], 2, '不要香菜'],
  ['A06', 20, 42, 'new', '', [['m03', 1], ['m04', 1], ['m11', 1], ['m14', 1]], 3, '团购顾客，稍后核销']
];

function buildOrders() {
  const base = new Date();
  base.setHours(0, 0, 0, 0);
  return SAMPLE.map((row, i) => {
    const [table, hour, minute, status, pay, lines, guests, note] = row;
    const ts = base.getTime() + hour * 3600000 + minute * 60000;
    const items = lines.map(l => item(l[0], l[1], l[2], l[3]));
    const gross = items.reduce((s, it) => s + it.price * it.qty, 0);
    const order = {
      no: table + '-' + String(101 + i), table, items, orderNote: note, guests, status,
      ts, timeHM: ('0' + hour).slice(-2) + ':' + ('0' + minute).slice(-2)
    };
    if (status === 'paid') {
      order.payMethod = pay;
      order.payName = PAY[pay];
      order.paySource = i % 5 === 0 ? 'customer' : 'cashier';
      order.payTs = ts + 25 * 60000;
      if (pay === 'meituan' || pay === 'dianping') order.settle = Math.round(gross * VOUCHER[pay]);
    }
    if (status === 'done') order.doneTs = ts + 18 * 60000;
    if (status === 'cooking') order.acceptTs = ts + 2 * 60000;
    return order;
  });
}

module.exports = function demoState() {
  const orders = buildOrders();
  return {
    version: 7,
    restaurant: '五山源·教学示范店',
    open: true,
    tables: ['A01', 'A02', 'A03', 'A04', 'A05', 'A06', 'A07', 'A08'],
    cats: CATS,
    menu: MENU,
    orders,
    seq: 132,
    voucher: {meituan: VOUCHER.meituan, dianping: VOUCHER.dianping},
    logs: [
      '开门营业，8 张桌台全部就绪',
      '午市高峰：11:30—13:30 共接待 9 桌',
      '美团团购券核销 2 张，按 8 折结算',
      '晚市上新「菌菇老鸭汤」，出餐 6 盅',
      '20:42 收到扫码订单 A06-130，等待接单',
      '当前在店 3 桌，后厨 4 单制作中'
    ]
  };
};
