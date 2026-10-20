function defaultState(){
  return {
    seq: 100,
    cats: ['凉菜','热菜','汤羹','主食','饮品'],
    menu: [
      {id:'d01',cat:'凉菜',name:'桂花糖藕',emoji:'🪷',price:22,unit:'',desc:'江南传统凉菜，糯米灌藕配桂花蜜',specs:null},
      {id:'d02',cat:'热菜',name:'松鼠桂鱼',emoji:'🐟',price:188,unit:'',desc:'苏帮菜代表，造型如松鼠，酸甜适口',specs:[{n:'半条',add:0},{n:'整条',add:0}],specPrice:{'半条':98,'整条':188}},
      {id:'d03',cat:'汤羹',name:'莼菜银鱼羹',emoji:'🍜',price:32,unit:'/位',desc:'太湖莼菜滑嫩，羹汤鲜洁',specs:null},
      {id:'d04',cat:'主食',name:'苏式焖肉面',emoji:'🍲',price:28,unit:'',desc:'枫镇大肉，焖煮四小时',specs:null},
      {id:'d05',cat:'饮品',name:'碧螺春茶',emoji:'🍵',price:12,unit:'/位',desc:'苏州洞庭山明前茶',specs:null}
    ],
    orders: []
  };
}
module.exports=defaultState;