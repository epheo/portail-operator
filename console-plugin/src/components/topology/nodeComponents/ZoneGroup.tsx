import { observer } from 'mobx-react';
import {
  DefaultGroup,
  GraphElement,
} from '@patternfly/react-topology';

type ZoneGroupProps = {
  element: GraphElement;
};

const ZoneGroupComponent: React.FC<ZoneGroupProps> = ({
  element,
  ...rest
}) => {
  const data = element.getData() as { zone?: string } | undefined;
  const zoneClass = data?.zone === 'external'
    ? 'portail-zone-external'
    : 'portail-zone-cluster';

  return (
    <DefaultGroup
      element={element}
      collapsible={false}
      showLabel
      hulledOutline
      className={zoneClass}
      {...rest}
    />
  );
};

export const ZoneGroup = observer(ZoneGroupComponent);
