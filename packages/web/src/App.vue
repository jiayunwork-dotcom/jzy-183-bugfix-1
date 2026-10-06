<script setup lang="ts">
import { RouterLink, RouterView } from 'vue-router';
</script>

<template>
  <header class="topbar">
    <RouterLink to="/" class="brand">测斜监测</RouterLink>
    <RouterLink to="/">预警总览</RouterLink>
    <RouterLink to="/probes">探头与标定</RouterLink>
    <RouterLink to="/boreholes/new">录入测孔</RouterLink>
  </header>
  <main>
    <RouterView />
  </main>
</template>
