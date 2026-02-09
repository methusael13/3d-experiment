/**
 * CategoryBrowser - Nested folder tree for browsing asset categories
 * Displays asset types and categories in a collapsible tree structure
 * 
 * New hierarchy:
 * - Models
 *   - Vegetation (grass, trees, ferns, etc.)
 *   - Others (props, rocks, etc.)
 * - Textures
 *   - IBL (HDR environments)
 *   - Others (texture packs)
 */

import { useMemo, useCallback } from 'preact/hooks';
import type { Asset } from '../../hooks/useAssetLibrary';
import styles from './CategoryBrowser.module.css';

// ==================== Types ====================

interface CategoryFilter {
  type?: string;
  category?: string | null;
  subtype?: string;
}

interface CategoryNode {
  id: string;
  name: string;
  nodeType: 'root' | 'type' | 'category' | 'subtype';
  count: number;
  children: CategoryNode[];
  filter: CategoryFilter | null;
}

export interface CategoryBrowserProps {
  assets: Asset[];
  selectedCategory: { type?: string; category?: string | null; subtype?: string } | null;
  expandedCategories: Set<string>;
  onSelectCategory: (filter: { type?: string; category?: string | null; subtype?: string } | null) => void;
  onToggleExpand: (categoryId: string) => void;
}

// ==================== Icons ====================

const FolderIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/>
  </svg>
);

const FolderOpenIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
    <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm0 12H4V8h16v10z"/>
  </svg>
);

const ChevronRightIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
  </svg>
);

const ChevronDownIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
    <path d="M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z"/>
  </svg>
);

// ==================== Helpers ====================

function buildCategoryTree(assets: Asset[]): CategoryNode {
  // Group assets by type -> category -> subtype
  const typeMap = new Map<string, Map<string | null, Map<string | null, number>>>();
  
  for (const asset of assets) {
    const type = asset.type || 'unknown';
    const category = asset.category ?? null;
    const subtype = asset.subtype ?? null;
    
    if (!typeMap.has(type)) {
      typeMap.set(type, new Map());
    }
    const categoryMap = typeMap.get(type)!;
    
    if (!categoryMap.has(category)) {
      categoryMap.set(category, new Map());
    }
    const subtypeMap = categoryMap.get(category)!;
    subtypeMap.set(subtype, (subtypeMap.get(subtype) || 0) + 1);
  }
  
  // Build tree structure
  const typeNodes: CategoryNode[] = [];
  
  for (const [type, categoryMap] of typeMap.entries()) {
    let typeCount = 0;
    const categoryNodes: CategoryNode[] = [];
    
    // Group: categorized items (vegetation, ibl) vs uncategorized
    const categorizedItems: CategoryNode[] = [];
    let uncategorizedSubtypes: Map<string | null, number> = new Map();
    
    for (const [category, subtypeMap] of categoryMap.entries()) {
      let categoryCount = 0;
      
      for (const [_, count] of subtypeMap.entries()) {
        categoryCount += count;
        typeCount += count;
      }
      
      if (category) {
        // Build subtype nodes for this category
        const subtypeNodes: CategoryNode[] = [];
        for (const [subtype, count] of subtypeMap.entries()) {
          if (subtype) {
            subtypeNodes.push({
              id: `${type}/${category}/${subtype}`,
              name: formatName(subtype),
              nodeType: 'subtype',
              count,
              children: [],
              filter: { type, category, subtype },
            });
          }
        }
        subtypeNodes.sort((a, b) => a.name.localeCompare(b.name));
        
        categorizedItems.push({
          id: `${type}/${category}`,
          name: formatCategoryName(category),
          nodeType: 'category',
          count: categoryCount,
          children: subtypeNodes,
          filter: { type, category },
        });
      } else {
        // Merge uncategorized items
        for (const [subtype, count] of subtypeMap.entries()) {
          const existing = uncategorizedSubtypes.get(subtype) || 0;
          uncategorizedSubtypes.set(subtype, existing + count);
        }
      }
    }
    
    // Add categorized items
    categorizedItems.sort((a, b) => a.name.localeCompare(b.name));
    categoryNodes.push(...categorizedItems);
    
    // Add "Others" for uncategorized if there are any
    if (uncategorizedSubtypes.size > 0) {
      let othersCount = 0;
      const otherSubtypeNodes: CategoryNode[] = [];
      
      for (const [subtype, count] of uncategorizedSubtypes.entries()) {
        othersCount += count;
        if (subtype) {
          otherSubtypeNodes.push({
            id: `${type}/others/${subtype}`,
            name: formatName(subtype),
            nodeType: 'subtype',
            count,
            children: [],
            filter: { type, category: null, subtype },
          });
        }
      }
      
      otherSubtypeNodes.sort((a, b) => a.name.localeCompare(b.name));
      
      // Only add "Others" category if there are categorized items too
      // Otherwise, show subtypes directly under type
      if (categorizedItems.length > 0) {
        categoryNodes.push({
          id: `${type}/others`,
          name: 'Others',
          nodeType: 'category',
          count: othersCount,
          children: otherSubtypeNodes,
          filter: { type, category: null },
        });
      } else {
        // No categories - show subtypes directly
        categoryNodes.push(...otherSubtypeNodes);
      }
    }
    
    typeNodes.push({
      id: type,
      name: formatTypeName(type),
      nodeType: 'type',
      count: typeCount,
      children: categoryNodes,
      filter: { type },
    });
  }
  
  // Sort types: models first, then textures, then others
  const typeOrder = ['model', 'texture', 'material', 'unknown'];
  typeNodes.sort((a, b) => {
    const aIndex = typeOrder.indexOf(a.id);
    const bIndex = typeOrder.indexOf(b.id);
    if (aIndex !== -1 && bIndex !== -1) return aIndex - bIndex;
    if (aIndex !== -1) return -1;
    if (bIndex !== -1) return 1;
    return a.name.localeCompare(b.name);
  });
  
  return {
    id: 'root',
    name: 'All Assets',
    nodeType: 'root',
    count: assets.length,
    children: typeNodes,
    filter: null,
  };
}

function formatName(name: string): string {
  // Convert snake_case or kebab-case to Title Case
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function formatTypeName(type: string): string {
  const typeNames: Record<string, string> = {
    'model': 'Models',
    'texture': 'Textures',
    'material': 'Materials',
    'unknown': 'Unknown',
  };
  return typeNames[type] || formatName(type);
}

function formatCategoryName(category: string): string {
  const categoryNames: Record<string, string> = {
    'vegetation': 'Vegetation',
    'ibl': 'IBL / HDR',
  };
  return categoryNames[category] || formatName(category);
}

function isSelected(
  nodeFilter: CategoryFilter | null,
  selectedFilter: CategoryFilter | null
): boolean {
  if (nodeFilter === null && selectedFilter === null) return true;
  if (nodeFilter === null || selectedFilter === null) return false;
  
  // Compare type
  if (nodeFilter.type !== selectedFilter.type) return false;
  
  // Compare category (handle null explicitly)
  const nodeCategory = nodeFilter.category ?? null;
  const selectedCategory = selectedFilter.category ?? null;
  if (nodeCategory !== selectedCategory) return false;
  
  // Compare subtype
  const nodeSubtype = nodeFilter.subtype ?? null;
  const selectedSubtype = selectedFilter.subtype ?? null;
  if (nodeSubtype !== selectedSubtype) return false;
  
  return true;
}

// ==================== TreeNode Component ====================

interface TreeNodeProps {
  node: CategoryNode;
  depth: number;
  selectedCategory: { type?: string; category?: string | null; subtype?: string } | null;
  expandedCategories: Set<string>;
  onSelectCategory: (filter: { type?: string; category?: string | null; subtype?: string } | null) => void;
  onToggleExpand: (categoryId: string) => void;
}

function TreeNode({
  node,
  depth,
  selectedCategory,
  expandedCategories,
  onSelectCategory,
  onToggleExpand,
}: TreeNodeProps) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expandedCategories.has(node.id);
  const isNodeSelected = isSelected(node.filter ?? null, selectedCategory);
  
  const handleClick = useCallback(() => {
    onSelectCategory(node.filter);
  }, [node.filter, onSelectCategory]);
  
  const handleToggle = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(node.id);
  }, [node.id, onToggleExpand]);
  
  return (
    <div class={styles.nodeContainer}>
      <div
        class={`${styles.node} ${isNodeSelected ? styles.selected : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={handleClick}
      >
        {hasChildren && (
          <button class={styles.toggleButton} onClick={handleToggle}>
            {isExpanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
          </button>
        )}
        {!hasChildren && <span class={styles.toggleSpacer} />}
        
        <span class={styles.icon}>
          {isExpanded ? <FolderOpenIcon /> : <FolderIcon />}
        </span>
        
        <span class={styles.name}>{node.name}</span>
        <span class={styles.count}>({node.count})</span>
      </div>
      
      {hasChildren && isExpanded && (
        <div class={styles.children}>
          {node.children.map(child => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedCategory={selectedCategory}
              expandedCategories={expandedCategories}
              onSelectCategory={onSelectCategory}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ==================== Main Component ====================

export function CategoryBrowser({
  assets,
  selectedCategory,
  expandedCategories,
  onSelectCategory,
  onToggleExpand,
}: CategoryBrowserProps) {
  const tree = useMemo(() => buildCategoryTree(assets), [assets]);
  
  return (
    <div class={styles.container}>
      <div class={styles.header}>Categories</div>
      <div class={styles.tree}>
        <TreeNode
          node={tree}
          depth={0}
          selectedCategory={selectedCategory}
          expandedCategories={expandedCategories}
          onSelectCategory={onSelectCategory}
          onToggleExpand={onToggleExpand}
        />
      </div>
    </div>
  );
}
