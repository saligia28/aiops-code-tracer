<template>
  <div class="price-check-list">
    <!-- 核价管理列表页：展示核价状态与吊牌价 -->
    <h2>核价管理</h2>
    <CommonTable :fetchTableData="getTableData">
      <span>{{ row.priceStatus }}</span>
    </CommonTable>
  </div>
</template>

<script>
import { getPriceCheckList } from '@/api/priceCheck'

export default {
  name: 'PriceCheckList',
  data() {
    return {
      columns: [
        { title: '核价状态', dataIndex: 'priceStatus' },
        { title: '吊牌价', dataIndex: 'tagPrice' },
      ],
    }
  },
  methods: {
    getTableData(query) {
      return getPriceCheckList(query)
    },
  },
}
</script>
