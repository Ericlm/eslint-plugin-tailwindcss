/**
 * @fileoverview Avoid using multiple Tailwind CSS classnames when not required (e.g. "mx-3 my-3" could be replaced by "m-3")
 * @author François Massart
 */
'use strict';

const docsUrl = require('../util/docsUrl');
const defaultGroups = require('../config/groups').groups;
const customConfig = require('../util/customConfig');
const astUtil = require('../util/ast');
const attrUtil = require('../util/attr');
const groupUtil = require('../util/groupMethods');
const getOption = require('../util/settings');
const parserUtil = require('../util/parser');

//------------------------------------------------------------------------------
// Rule Definition
//------------------------------------------------------------------------------

// Predefine message for use in context.report conditional.
// messageId will still be usable in tests.
const SHORTHAND_CANDIDATE_CLASSNAMES_DETECTED_MSG = `Classnames '{{classnames}}' could be replaced by the '{{shorthand}}' shorthand!`;

module.exports = {
  meta: {
    docs: {
      description: 'Enforces the usage of shorthand Tailwind CSS classnames',
      category: 'Best Practices',
      recommended: true,
      url: docsUrl('enforces-shorthand'),
    },
    messages: {
      shorthandCandidateDetected: SHORTHAND_CANDIDATE_CLASSNAMES_DETECTED_MSG,
    },
    fixable: 'code',
    schema: [
      {
        type: 'object',
        properties: {
          callees: {
            type: 'array',
            items: { type: 'string', minLength: 0 },
            uniqueItems: true,
          },
          config: {
            default: 'tailwind.config.js',
            type: ['string', 'object'],
          },
          tags: {
            type: 'array',
            items: { type: 'string', minLength: 0 },
            uniqueItems: true,
          },
        },
      },
    ],
  },

  create: function (context) {
    const callees = getOption(context, 'callees');
    const tags = getOption(context, 'tags');
    const twConfig = getOption(context, 'config');

    const mergedConfig = customConfig.resolve(twConfig);

    //----------------------------------------------------------------------
    // Helpers
    //----------------------------------------------------------------------

    // Init assets
    const targetProperties = {
      Layout: ['Overflow', 'Overscroll Behavior', 'Top / Right / Bottom / Left'],
      'Flexbox & Grid': ['Gap'],
      Spacing: ['Padding', 'Margin'],
      Borders: ['Border Radius', 'Border Width', 'Border Color'],
      Transforms: ['Scale'],
    };
    // We don't want to affect other rules by object reference
    const cloned = JSON.parse(JSON.stringify(defaultGroups));
    const targetGroups = cloned.filter((g) => Object.keys(targetProperties).includes(g.type));
    targetGroups.forEach((g) => {
      // Without using the clone, other rules would be affected by this `filter()`
      g.members = g.members.filter((sub) => targetProperties[g.type].includes(sub.type));
    });

    /**
     * Retrieve the main part of a classname base on its shorthand scope
     * @param {Object} targetGroups A specific subset of the groups
     * @param {String} parentType The name of the parent e.g. 'Border Radius'
     * @param {String} shorthand The searched shorthand e.g. 'all', 'y', 't', 'tr'
     * @returns
     */
    const getBodyByShorthand = (targetGroups, parentType, shorthand) => {
      const findByMemberType = (obj) => obj.members.find((m) => m.type === parentType);
      const mainGroup = targetGroups.find(findByMemberType);
      if (!mainGroup) {
        return '';
      }
      const typeGroup = mainGroup.members.find((m) => m.type === parentType);
      // const typeGroup = mainGroup.find(findByMemberType);
      if (!typeGroup) {
        return '';
      }
      const type = typeGroup.members.find((m) => m.shorthand === shorthand);
      return !type ? '' : type.body;
    };

    /**
     * Parse the classnames and report found shorthand candidates
     * @param {ASTNode} node The root node of the current parsing
     * @param {ASTNode} arg The child node of node
     * @returns {void}
     */
    const parseForShorthandCandidates = (node, arg = null) => {
      let originalClassNamesValue = null;
      let start = null;
      let end = null;
      let prefix = '';
      let suffix = '';
      let trim = false;
      const troubles = [];
      if (arg === null) {
        originalClassNamesValue = astUtil.extractValueFromNode(node);
        const range = astUtil.extractRangeFromNode(node);
        start = range[0] + 1;
        end = range[1] - 1;
      } else {
        switch (arg.type) {
          case 'TemplateLiteral':
            arg.expressions.forEach((exp) => {
              parseForShorthandCandidates(node, exp);
            });
            arg.quasis.forEach((quasis) => {
              parseForShorthandCandidates(node, quasis);
            });
            return;
          case 'ConditionalExpression':
            parseForShorthandCandidates(node, arg.consequent);
            parseForShorthandCandidates(node, arg.alternate);
            return;
          case 'LogicalExpression':
            parseForShorthandCandidates(node, arg.right);
            return;
          case 'Literal':
            trim = true;
            originalClassNamesValue = arg.value;
            start = arg.range[0] + 1;
            end = arg.range[1] - 1;
            break;
          case 'TemplateElement':
            originalClassNamesValue = arg.value.raw;
            start = arg.range[0];
            end = arg.range[1];
            // https://github.com/eslint/eslint/issues/13360
            // The problem is that range computation includes the backticks (`test`)
            // but value.raw does not include them, so there is a mismatch.
            // start/end does not include the backticks, therefore it matches value.raw.
            const txt = context.getSourceCode().getText(arg);
            prefix = astUtil.getTemplateElementPrefix(txt, originalClassNamesValue);
            suffix = astUtil.getTemplateElementSuffix(txt, originalClassNamesValue);
            break;
        }
      }

      let classNames = attrUtil.getClassNamesFromAttribute(originalClassNamesValue, trim);
      const isSingleLine = attrUtil.isSingleLine(originalClassNamesValue);
      let before = null;
      let after = null;

      if (!isSingleLine) {
        const spacesOnly = /^(\s)*$/;
        if (spacesOnly.test(classNames[0])) {
          before = classNames.shift();
        }
        if (spacesOnly.test(classNames[classNames.length - 1])) {
          after = classNames.pop();
        }
      }

      if (classNames.length <= 1) {
        // Don't run sorting for a single or empty className
        return;
      }

      const parsed = [];

      classNames.forEach((className, index) => {
        parsed.push(groupUtil.parseClassname(className, targetGroups, mergedConfig, index));
      });

      const validated = [];
      // Each group parentType
      const checkedGroups = [];
      parsed.forEach((classname) => {
        // Valid candidate
        if (classname.parentType === '') {
          validated.push(classname);
        } else if (!checkedGroups.includes(classname.parentType)) {
          checkedGroups.push(classname.parentType);
          const sameType = parsed.filter((cls) => cls.parentType === classname.parentType);
          // Comparing same parentType classnames
          const checkedVariantsValue = [];
          sameType.forEach((cls) => {
            const key = cls.variants + cls.value;
            if (!checkedVariantsValue.includes(key)) {
              checkedVariantsValue.push(key);
              const sameVariantAndValue = sameType.filter((v) => {
                return v.variants === cls.variants && v.value === cls.value;
              });
              if (sameVariantAndValue.length === 1) {
                validated.push(cls);
              } else if (sameVariantAndValue.length) {
                const supportCorners = ['Border Radius'].includes(classname.parentType);
                const hasTL =
                  supportCorners && sameVariantAndValue.some((c) => ['tl', 't', 'all'].includes(c.shorthand));
                const hasTR =
                  supportCorners && sameVariantAndValue.some((c) => ['tr', 't', 'all'].includes(c.shorthand));
                const hasBR =
                  supportCorners && sameVariantAndValue.some((c) => ['br', 'b', 'all'].includes(c.shorthand));
                const hasBL =
                  supportCorners && sameVariantAndValue.some((c) => ['bl', 'b', 'all'].includes(c.shorthand));
                const hasT = sameVariantAndValue.some((c) => c.shorthand === 't') || (hasTL && hasTR);
                const hasR = sameVariantAndValue.some((c) => c.shorthand === 'r') || (hasTR && hasBR);
                const hasB = sameVariantAndValue.some((c) => c.shorthand === 'b') || (hasBL && hasBR);
                const hasL = sameVariantAndValue.some((c) => c.shorthand === 'l') || (hasTL && hasBL);
                const hasX = sameVariantAndValue.some((c) => c.shorthand === 'x') || (hasL && hasR);
                const hasY = sameVariantAndValue.some((c) => c.shorthand === 'y') || (hasT && hasB);
                const hasAll = sameVariantAndValue.some((c) => c.shorthand === 'all') || (hasY && hasX);
                const isNegative = ('' + cls.value).substring(0, 1) === '-';
                const minus = isNegative ? '-' : '';
                const absoluteVal = isNegative ? ('' + cls.value).substring(1) : cls.value;

                if (hasAll) {
                  const all = getBodyByShorthand(targetGroups, classname.parentType, 'all');
                  const patchedName = `${cls.variants}${minus}${all}${absoluteVal.length ? '-' + absoluteVal : ''}`;
                  troubles.push([sameVariantAndValue.map((c) => c.name), patchedName]);
                  cls.name = patchedName;
                  cls.shorthand = 'all';
                  validated.push(cls);
                } else if (hasY || hasX) {
                  const xOrY = hasX ? 'x' : 'y';
                  const xOrYType = getBodyByShorthand(targetGroups, classname.parentType, xOrY);
                  const patchedName = `${cls.variants}${minus}${xOrYType}${
                    absoluteVal.length ? '-' + absoluteVal : ''
                  }`;
                  const toBeReplaced = sameVariantAndValue
                    .filter((c) => {
                      const candidates = hasX ? ['l', 'r'] : ['t', 'b'];
                      return candidates.includes(c.shorthand);
                    })
                    .map((c) => c.name);
                  const toBeKept = sameVariantAndValue.filter((c) => {
                    const candidates = hasY ? ['l', 'r'] : ['t', 'b'];
                    return candidates.includes(c.shorthand);
                  });

                  troubles.push([toBeReplaced, patchedName]);
                  cls.name = patchedName;
                  cls.shorthand = xOrY;
                  validated.push(cls);
                  if (toBeKept.length) {
                    validated.push(...toBeKept);
                  }
                } else if (supportCorners && (hasT || hasR || hasB || hasL)) {
                  const side = hasT ? 't' : hasR ? 'r' : hasB ? 'b' : 'l';
                  const sideBody = getBodyByShorthand(targetGroups, classname.parentType, side);
                  const patchedName = `${cls.variants}${minus}${sideBody}${
                    absoluteVal.length ? '-' + absoluteVal : ''
                  }`;
                  const toBeReplaced = sameVariantAndValue
                    .filter((c) => {
                      const candidates = hasT ? ['tl', 'tr'] : hasR ? ['tr', 'br'] : hasB ? ['bl', 'br'] : ['tl', 'bl'];
                      return candidates.includes(c.shorthand);
                    })
                    .map((c) => c.name);
                  const toBeKept = sameVariantAndValue.filter((c) => {
                    const candidates = hasT ? ['bl', 'br'] : hasR ? ['tl', 'bl'] : hasB ? ['tl', 'tr'] : ['tr', 'br'];
                    return candidates.includes(c.shorthand);
                  });

                  troubles.push([toBeReplaced, patchedName]);
                  cls.name = patchedName;
                  cls.shorthand = side;
                  validated.push(cls);
                  if (toBeKept.length) {
                    validated.push(...toBeKept);
                  }
                } else {
                  validated.push(...sameVariantAndValue);
                }
              }
            }
          });
        }
      });

      // Generates the validated attribute value
      const union = validated.map((val) => val.leading + val.name + val.trailing);

      if (before !== null) {
        union.unshift(before);
      }
      if (after !== null) {
        union.push(after);
      }
      let validatedClassNamesValue = union.join(isSingleLine ? ' ' : '\n');
      const originalPatched = isSingleLine ? originalClassNamesValue.trim() : originalClassNamesValue;
      troubles
        .filter((trouble) => {
          // Only valid issue if there are classes to replace
          return trouble[0].length;
        })
        .forEach((issue) => {
          if (originalPatched !== validatedClassNamesValue) {
            validatedClassNamesValue = prefix + validatedClassNamesValue + suffix;
            context.report({
              node: node,
              messageId: 'shorthandCandidateDetected',
              data: {
                classnames: issue[0].join(', '),
                shorthand: issue[1],
              },
              fix: function (fixer) {
                return fixer.replaceTextRange([start, end], validatedClassNamesValue);
              },
            });
          }
        });
    };

    //----------------------------------------------------------------------
    // Public
    //----------------------------------------------------------------------

    const scriptVisitor = {
      JSXAttribute: function (node) {
        if (!astUtil.isValidJSXAttribute(node)) {
          return;
        }
        parseForShorthandCandidates(node);
      },
      CallExpression: function (node) {
        if (callees.findIndex((name) => node.callee.name === name) === -1) {
          return;
        }

        node.arguments.forEach((arg) => {
          parseForShorthandCandidates(node, arg);
        });
      },
      TaggedTemplateExpression: function (node) {
        if (!tags.includes(node.tag.name)) {
          return;
        }

        parseForShorthandCandidates(node, node.quasi);
      },
    };

    const templateVisitor = {
      VAttribute: function (node) {
        if (!astUtil.isValidVueAttribute(node)) {
          return;
        }
        parseForShorthandCandidates(node);
      },
    };

    return parserUtil.defineTemplateBodyVisitor(context, templateVisitor, scriptVisitor);
  },
};