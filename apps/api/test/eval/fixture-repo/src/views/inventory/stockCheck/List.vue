<template>
  <div class="stock-check-list">
    <!-- 备料核料列表页 -->
    <h2>备料核料</h2>
    <CommonTable :fetchTableData="getTableData">
      <el-button @click="handleCheck(row)">核料</el-button>
    </CommonTable>
  </div>
</template>

<script>
import { getStockCheckList, confirmStockCheck } from '@/api/stockCheck'

export default {
  name: 'StockCheckList',
  methods: {
    getTableData(query) {
      return getStockCheckList(query)
    },
    // 核料确认：核对备料数量后提交
    handleCheck(row) {
      return confirmStockCheck(row.id)
    },
  },
}
</script>
