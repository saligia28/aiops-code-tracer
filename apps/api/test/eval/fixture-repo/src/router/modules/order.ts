// 订单域路由配置
const orderRouter = [
  {
    path: '/orderManage/orderVoid',
    name: 'OrderVoidList',
    component: () => import('@/views/orderManage/orderVoid/List.vue'),
    meta: { title: '订单作废管理' },
  },
  {
    path: '/inventory/stockCheck',
    name: 'StockCheckList',
    component: () => import('@/views/inventory/stockCheck/List.vue'),
    meta: { title: '备料核料' },
  },
  {
    path: '/costManagement/priceCheck',
    name: 'PriceCheckList',
    component: () => import('@/views/costManagement/priceCheck/List.vue'),
    meta: { title: '核价管理' },
  },
]

export default orderRouter
