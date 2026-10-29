// Snapshot an enemy inventory into independent loot entries, without generating any bonus items.
export function inventoryToLoot(inventory) {
  const items=[];
  for(const slot of inventory.slots) if(slot) items.push({kind:'weapon',id:slot.id,rounds:slot.rounds});
  for(const [id,amount] of Object.entries(inventory.ammo)) if(amount>0) items.push({kind:'ammo',id,amount});
  for(const [kind,field] of [['medkit','medkits'],['boost','boosts'],['grenade','grenades']]) {
    if(inventory[field]>0) items.push({kind,amount:inventory[field]});
  }
  for(const kind of ['armor','helmet']) if(inventory[kind]>0) items.push({kind,level:inventory[kind]});
  return items;
}
